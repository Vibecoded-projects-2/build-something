import { createHmac, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.ts";
import { parseConfig } from "../server/config.ts";
import type { Db } from "../server/db.ts";
import { SafeError } from "../server/domain.ts";
import { createHandlers } from "../server/engine.ts";
import { Worker } from "../server/worker.ts";
import { FakeGitHub } from "./fake-github.ts";
import { candidate, FakeModel } from "./fake-model.ts";
import { testDb, WORKSPACE } from "./helpers.ts";

const password = "correct-horse-battery-staple";
const secret = "webhook-secret";
const HEAD = "a".repeat(40);
const PATCH = "@@ -1 +1,2 @@\n context\n+  return total / values.length;";

const config = parseConfig({
  ADMIN_PASSWORD: password,
  TARGET_ACCOUNT: WORKSPACE,
  GITHUB_WEBHOOK_SECRET: secret,
  GITHUB_APP_SLUG: "reviewgate-acme",
  ANTHROPIC_API_KEY: "test-key",
});

describe("dashboard API", () => {
  let db: Db;
  let app: FastifyInstance;
  let github: FakeGitHub;
  let model: FakeModel;
  let worker: Worker;
  let cookies: Record<string, string>;
  let headers: Record<string, string>;

  beforeEach(async () => {
    db = await testDb();
    github = new FakeGitHub();
    model = new FakeModel();
    app = await createApp({ config, db, hasGitHubClient: true });
    worker = new Worker({ db, handlers: createHandlers({ config, db, github, model }) });

    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "admin", password },
    });
    cookies = { reviewgate_session: login.cookies[0]!.value };
    headers = { "x-csrf-token": login.json().csrfToken, origin: config.appOrigin };

    github.addPullRequest();
    github.files.set(1, [{ path: "src/average.ts", status: "modified", patch: PATCH }]);
    github.sources.set("src/average.ts", "context\n  return total / values.length;\n");
    model.findings = [candidate()];
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  const review = async () => {
    const body = JSON.stringify({
      action: "opened",
      installation: { id: 7 },
      repository: { id: 10, full_name: "acme/app", private: true, archived: false, owner: { login: "acme" } },
      pull_request: { number: 1 },
    });
    await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": randomUUID(),
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
    });
    await worker.drain();
  };

  const get = (url: string) => app.inject({ url, cookies });
  const dashboard = async () => (await get("/api/dashboard")).json();

  it("requires a session for protected reads", async () => {
    for (const url of ["/api/dashboard", "/api/prs/10%3A1"]) {
      expect((await app.inject({ url })).statusCode).toBe(401);
    }
  });

  it("requires CSRF for mutations", async () => {
    const response = await app.inject({ method: "POST", url: "/api/sync", cookies });
    expect(response.statusCode).toBe(403);
  });

  it("validates the dashboard window", async () => {
    expect((await get("/api/dashboard?days=7")).statusCode).toBe(200);
    expect((await get("/api/dashboard?days=8")).statusCode).toBe(400);
  });

  it("returns an empty workspace with null rates rather than made-up values", async () => {
    const data = await dashboard();
    expect(data.metrics).toMatchObject({
      monitoredRepositories: 0,
      reviewRuns: 0,
      prCoverage: null,
      successRate: null,
      latencyMedianSeconds: null,
    });
    expect(data.repositories).toEqual([]);
  });

  it("reports metrics from the records of a real pipeline run", async () => {
    await review();
    const data = await dashboard();

    expect(data.metrics).toMatchObject({
      monitoredRepositories: 1,
      totalPrs: 1,
      reviewedPrs: 1,
      prCoverage: 1,
      reviewRuns: 1,
      findings: 1,
      confirmedFixes: 0,
      successRate: 1,
    });
    expect(data.metrics.estimatedCostUsd).toBeCloseTo(0.12);
    expect(data.metrics.latencyMedianSeconds).toEqual(expect.any(Number));
    expect(data.categories).toEqual([{ category: "correctness", count: 1 }]);
    expect(data.repositories[0]).toMatchObject({ fullName: "acme/app", enabled: true, reviewCount: 1 });
    expect(data.pullRequests[0]).toMatchObject({ number: 1, runState: "completed", findingCount: 1 });
    expect(data.findings[0]).toMatchObject({ repository: "acme/app", prNumber: 1, outcome: "open" });
    expect(data.runs[0]).toMatchObject({ state: "completed", headSha: HEAD, jobState: "completed" });
    expect(data.budget).toMatchObject({ limitUsd: 50, reservedUsd: 0 });
    expect(data.integrations).toEqual({
      githubApp: true,
      webhookSecret: true,
      anthropicKey: true,
      sqs: false,
    });
    expect(data.settings.installUrl).toBe("https://github.com/apps/reviewgate-acme/installations/new");
  });

  it("keeps follow-up runs out of the distinct PR count", async () => {
    await review();
    github.pullRequests[0]!.headSha = "c".repeat(40);
    await review();
    const data = await dashboard();
    expect(data.metrics.reviewRuns).toBe(2);
    expect(data.metrics.reviewedPrs).toBe(1);
  });

  it("counts a confirmed fix only after a human confirms it", async () => {
    await review();
    const { findings } = await dashboard();
    const id = findings[0].id;

    await db.query(`UPDATE findings SET thread_resolved = true, outcome = 'suspected_fixed'`);
    expect((await dashboard()).metrics).toMatchObject({ confirmedFixes: 0, suspectedFixes: 1 });

    const confirm = await app.inject({
      method: "PATCH",
      url: `/api/findings/${id}`,
      cookies,
      headers,
      payload: { outcome: "confirmed_fixed", evidence: "Guard restored", fixSha: HEAD },
    });
    expect(confirm.statusCode).toBe(200);
    expect((await dashboard()).metrics).toMatchObject({ confirmedFixes: 1, suspectedFixes: 0 });
  });

  it("explains a rejected confirmation", async () => {
    await review();
    const { findings } = await dashboard();
    const response = await app.inject({
      method: "PATCH",
      url: `/api/findings/${findings[0].id}`,
      cookies,
      headers,
      payload: { outcome: "confirmed_fixed", evidence: "Guard restored", fixSha: "abc" },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ ok: false, error: "INVALID_FIX_SHA" });
  });

  it("keeps unpublished findings out of published figures", async () => {
    github.beforeCreateReview = () => {
      throw new SafeError("GITHUB_RATE_LIMITED", true);
    };
    await review();
    expect(await db.query(`SELECT id FROM findings`)).toHaveLength(1);
    const data = await dashboard();
    expect(data.metrics.findings).toBe(0);
    expect(data.findings).toEqual([]);
  });

  it("returns PR detail with all runs and published findings", async () => {
    await review();
    const response = await get(`/api/prs/${encodeURIComponent("10:1")}`);
    const detail = response.json();
    expect(detail.pullRequest).toMatchObject({ number: 1, repository: "acme/app" });
    expect(detail.runs).toHaveLength(1);
    expect(detail.findings).toHaveLength(1);
    expect((await get("/api/prs/404%3A1")).statusCode).toBe(404);
  });

  it("toggles monitoring and audits the change", async () => {
    await review();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/repos/10",
      cookies,
      headers,
      payload: { enabled: false },
    });
    expect(response.statusCode).toBe(200);
    expect((await dashboard()).repositories[0].enabled).toBe(false);
    expect((await dashboard()).metrics.monitoredRepositories).toBe(0);

    const events = await db.query(`SELECT action FROM audit_events`);
    expect(events).toEqual([{ action: "repository.paused" }]);

    const missing = await app.inject({
      method: "PATCH",
      url: "/api/repos/99",
      cookies,
      headers,
      payload: { enabled: false },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("enqueues a sync when the App is configured", async () => {
    const response = await app.inject({ method: "POST", url: "/api/sync", cookies, headers });
    expect(response.json()).toEqual({ ok: true });
    expect(await db.query(`SELECT kind FROM jobs`)).toEqual([{ kind: "sync" }]);
  });

  it("reports a failed sync as an application error", async () => {
    const other = await createApp({ config, db, hasGitHubClient: false });
    const response = await other.inject({ method: "POST", url: "/api/sync", cookies, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: false, error: "GITHUB_APP_NOT_CONFIGURED" });
    await other.close();
  });

  it("retries only dead failed or publishing runs", async () => {
    github.beforeCreateReview = () => {
      throw new SafeError("GITHUB_ACCESS_DENIED");
    };
    await review();
    const [run] = await db.query(`SELECT id, state FROM review_runs`);
    expect(run?.state).toBe("publishing");

    const retry = () =>
      app.inject({ method: "POST", url: `/api/runs/${run!.id}/retry`, cookies, headers });

    expect((await retry()).json()).toEqual({ ok: true });
    expect((await retry()).statusCode).toBe(409);

    github.beforeCreateReview = undefined;
    await worker.drain();
    expect((await db.query(`SELECT state FROM review_runs`))[0]?.state).toBe("completed");
    expect((await retry()).statusCode).toBe(409);
  });

  it("does not reveal raw error detail", async () => {
    const response = await app.inject({ method: "POST", url: "/api/runs/unknown/retry", cookies, headers });
    expect(response.statusCode).toBe(404);
  });
});
