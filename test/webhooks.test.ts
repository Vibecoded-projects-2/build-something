import { createHmac, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.ts";
import { parseConfig } from "../server/config.ts";
import type { Db } from "../server/db.ts";
import { normalizeWebhook } from "../server/webhooks.ts";
import { testDb, WORKSPACE } from "./helpers.ts";

const secret = "webhook-secret";
const config = parseConfig({
  ADMIN_PASSWORD: "correct-horse-battery-staple",
  TARGET_ACCOUNT: WORKSPACE,
  GITHUB_WEBHOOK_SECRET: secret,
});

const prPayload = {
  action: "opened",
  installation: { id: 7 },
  repository: {
    id: 10,
    full_name: "acme/app",
    private: true,
    archived: false,
    owner: { login: "Acme" },
    description: "not retained",
  },
  pull_request: { number: 3, title: "not retained", body: "not retained" },
};

function deliver(app: FastifyInstance, options: {
  body?: string;
  event?: string;
  guid?: string;
  signature?: string | null;
}) {
  const body = options.body ?? JSON.stringify(prPayload);
  const signature =
    options.signature === undefined
      ? `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
      : options.signature;
  return app.inject({
    method: "POST",
    url: "/webhooks/github",
    payload: body,
    headers: {
      "content-type": "application/json",
      "x-github-event": options.event ?? "pull_request",
      "x-github-delivery": options.guid ?? randomUUID(),
      ...(signature === null ? {} : { "x-hub-signature-256": signature }),
    },
  });
}

describe("GitHub webhook ingestion", () => {
  let db: Db;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = await testDb();
    app = await createApp({ config, db });
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  const jobCount = async () =>
    (await db.query(`SELECT count(*)::int AS count FROM jobs`))[0]?.count;

  it("rejects unsigned and wrongly signed deliveries", async () => {
    expect((await deliver(app, { signature: null })).statusCode).toBe(401);
    expect((await deliver(app, { signature: "sha256=abc" })).statusCode).toBe(401);
    expect((await deliver(app, { signature: `sha256=${"0".repeat(64)}` })).statusCode).toBe(401);
    expect(await jobCount()).toBe(0);
  });

  it("verifies the raw bytes rather than reserialized JSON", async () => {
    const spaced = JSON.stringify(prPayload, null, 2);
    expect((await deliver(app, { body: spaced })).statusCode).toBe(202);
    expect(await jobCount()).toBe(1);
  });

  it("requires a UUID delivery id", async () => {
    expect((await deliver(app, { guid: "not-a-uuid" })).statusCode).toBe(400);
  });

  it("accepts a valid ping without creating work", async () => {
    const response = await deliver(app, { event: "ping", body: "{}" });
    expect(response.statusCode).toBe(200);
    expect(await jobCount()).toBe(0);
  });

  it("ignores unsupported events", async () => {
    const response = await deliver(app, { event: "star" });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ ok: true, ignored: true });
    expect(await jobCount()).toBe(0);
  });

  it("ignores events from another owner", async () => {
    const body = JSON.stringify({
      ...prPayload,
      repository: { ...prPayload.repository, owner: { login: "someone-else" } },
    });
    expect((await deliver(app, { body })).json()).toEqual({ ok: true, ignored: true });
    expect(await jobCount()).toBe(0);
  });

  it("records a delivery and its job once", async () => {
    const guid = randomUUID();
    expect((await deliver(app, { guid })).json()).toEqual({ ok: true, queued: true });
    expect((await deliver(app, { guid })).json()).toEqual({ ok: true, queued: false });
    expect(await jobCount()).toBe(1);
  });

  it("persists only normalized fields", async () => {
    await deliver(app, {});
    const [job] = await db.query(`SELECT payload FROM jobs`);
    expect(job?.payload).toEqual({
      event: "pull_request",
      action: "opened",
      installationId: 7,
      repository: { id: 10, fullName: "acme/app", private: true, archived: false },
      prNumber: 3,
      threadCommentIds: [],
    });
    expect(JSON.stringify(job?.payload)).not.toContain("not retained");
  });

  it("reports when the webhook secret is not configured", async () => {
    const unconfigured = parseConfig({
      ADMIN_PASSWORD: "correct-horse-battery-staple",
      TARGET_ACCOUNT: WORKSPACE,
    });
    const otherApp = await createApp({ config: unconfigured, db });
    const response = await deliver(otherApp, {});
    expect(response.statusCode).toBe(503);
    await otherApp.close();
  });

  it("keeps normal JSON parsing on API routes", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "admin", password: "correct-horse-battery-staple" },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe("normalizeWebhook", () => {
  it("extracts thread comment ids", () => {
    const normalized = normalizeWebhook("pull_request_review_thread", {
      action: "resolved",
      thread: { comments: [{ id: 1 }, { id: 2 }] },
    });
    expect(normalized.threadCommentIds).toEqual([1, 2]);
    expect(normalized.repository).toBeNull();
  });
});
