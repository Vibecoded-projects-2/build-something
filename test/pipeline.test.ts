import { createHmac, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.ts";
import { parseConfig } from "../server/config.ts";
import type { Db } from "../server/db.ts";
import { SafeError } from "../server/domain.ts";
import { createHandlers, filterCandidates, runReview, type EngineDeps } from "../server/engine.ts";
import { claimJob, MAX_ATTEMPTS } from "../server/jobs.ts";
import { Worker } from "../server/worker.ts";
import { FakeGitHub } from "./fake-github.ts";
import { candidate, FakeModel } from "./fake-model.ts";
import { testDb, WORKSPACE } from "./helpers.ts";

const HEAD = "a".repeat(40);
const NEW_HEAD = "c".repeat(40);
const PATCH = "@@ -1,2 +1,2 @@\n export function average(values) {\n+  return sum(values) / values.length;";
const secret = "webhook-secret";

const config = parseConfig({
  ADMIN_PASSWORD: "correct-horse-battery-staple",
  TARGET_ACCOUNT: WORKSPACE,
  GITHUB_WEBHOOK_SECRET: secret,
  MONTHLY_BUDGET_USD: "10",
});

const webhookPayload = {
  action: "opened",
  installation: { id: 7 },
  repository: { id: 10, full_name: "acme/app", private: true, archived: false, owner: { login: "acme" } },
  pull_request: { number: 1 },
};

describe("review pipeline", () => {
  let db: Db;
  let github: FakeGitHub;
  let model: FakeModel;
  let deps: EngineDeps;
  let app: FastifyInstance;
  let worker: Worker;

  beforeEach(async () => {
    db = await testDb();
    github = new FakeGitHub();
    model = new FakeModel();
    deps = { config, db, github, model };
    app = await createApp({ config, db });
    worker = new Worker({ db, handlers: createHandlers(deps) });

    github.addPullRequest();
    github.files.set(1, [{ path: "src/average.ts", status: "modified", patch: PATCH }]);
    github.sources.set("src/average.ts", "export function average(values) {\n  return sum(values) / values.length;\n}\n");
    model.findings = [candidate()];
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  const deliver = (payload: unknown = webhookPayload, guid = randomUUID(), event = "pull_request") => {
    const body = JSON.stringify(payload);
    return app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": guid,
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
    });
  };

  const makeJobsReady = () => db.query(`UPDATE jobs SET available_at = now() WHERE state = 'pending'`);
  const runs = () => db.query(`SELECT * FROM review_runs ORDER BY created_at`);
  const findings = () => db.query(`SELECT * FROM findings ORDER BY created_at`);

  const reviewOnce = async () => {
    await deliver();
    await worker.drain();
  };

  it("rejects an unsigned delivery and publishes once for a redelivered one", async () => {
    const unsigned = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload: JSON.stringify(webhookPayload),
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": randomUUID(),
      },
    });
    expect(unsigned.statusCode).toBe(401);

    const guid = randomUUID();
    await deliver(webhookPayload, guid);
    await deliver(webhookPayload, guid);
    await worker.drain();
    await deliver(webhookPayload, guid);
    await deliver();
    await worker.drain();

    expect(github.reviews).toHaveLength(1);
    expect(model.generateCalls).toBe(1);

    const [review] = github.reviews;
    expect(review?.commitSha).toBe(HEAD);
    expect(review?.comments).toHaveLength(1);
    expect(review?.comments[0]).toMatchObject({ path: "src/average.ts", line: 2 });
    expect(review?.body).toContain("<!-- reviewgate:run:");

    const [run] = await runs();
    expect(run).toMatchObject({ state: "completed", head_sha: HEAD, error_code: null });
    expect(Number(run?.github_review_id)).toBe(1000);
    expect(run?.usage).toMatchObject({ inputTokens: 20_000, outputTokens: 2_000 });

    const [finding] = await findings();
    expect(Number(finding?.github_comment_id)).toBe(10000);
    expect(finding?.github_comment_url).toContain("discussion_r");
  });

  it("publishes a summary review when there are no findings", async () => {
    model.findings = [];
    await reviewOnce();
    expect(github.reviews[0]?.comments).toEqual([]);
    expect(model.verifyCalls).toBe(0);
    expect((await runs())[0]?.state).toBe("completed");
  });

  it("drops candidates the verification pass rejects", async () => {
    model.findings = [candidate(), candidate({ title: "Second candidate defect" })];
    model.accepted = [1];
    await reviewOnce();
    expect((await findings()).map((row) => row.title)).toEqual(["Second candidate defect"]);
  });

  it("ignores out-of-range indices from the model", async () => {
    model.accepted = [0, 0, 5];
    await reviewOnce();
    expect(await findings()).toHaveLength(1);
  });

  it("rejects findings outside added diff lines", async () => {
    model.findings = [
      candidate({ line: 1, title: "On a context line" }),
      candidate({ path: "src/other.ts", title: "Unchanged file finding" }),
    ];
    await reviewOnce();
    expect(await findings()).toHaveLength(0);
    expect(github.reviews[0]?.comments).toEqual([]);
  });

  it("filters duplicates by fingerprint", () => {
    const anchors = new Map([["src/average.ts", new Set([2])]]);
    expect(filterCandidates([candidate(), candidate()], anchors, new Set())).toHaveLength(1);
  });

  it("does not repeat a finding on a follow-up commit", async () => {
    await reviewOnce();
    github.pullRequests[0]!.headSha = NEW_HEAD;
    await deliver({ ...webhookPayload, action: "synchronize" });
    await worker.drain();

    expect(await runs()).toHaveLength(2);
    expect(await findings()).toHaveLength(1);
    expect(github.reviews).toHaveLength(2);
    expect(github.reviews[1]?.comments).toEqual([]);
    expect(github.reviews[1]?.commitSha).toBe(NEW_HEAD);
  });

  it("supersedes in-flight work when the PR head advances", async () => {
    model.beforeGenerate = () => {
      if (model.generateCalls === 1) github.pullRequests[0]!.headSha = NEW_HEAD;
    };
    await reviewOnce();

    const [first, second] = await runs();
    expect(first?.state).toBe("superseded");
    expect(second).toMatchObject({ state: "completed", head_sha: NEW_HEAD });
    expect(github.reviews.map((review) => review.commitSha)).toEqual([NEW_HEAD]);
    expect(await findings()).toHaveLength(1);
  });

  it("supersedes a queued run before spending on the model", async () => {
    await deliver();
    await worker.runNext();
    github.pullRequests[0]!.headSha = NEW_HEAD;
    await worker.drain();
    expect(model.generateCalls).toBe(1);
    expect((await runs()).map((run) => run.state)).toEqual(["superseded", "completed"]);
  });

  it("treats a base-only change as stale", async () => {
    model.beforeGenerate = () => {
      if (model.generateCalls === 1) github.pullRequests[0]!.baseSha = "d".repeat(40);
    };
    await reviewOnce();
    expect((await runs()).map((run) => run.state)).toEqual(["superseded", "completed"]);
    expect(github.reviews).toHaveLength(1);
  });

  it("recovers when GitHub accepted a review but the response was lost", async () => {
    github.loseNextResponse = true;
    await reviewOnce();
    expect((await runs())[0]).toMatchObject({ state: "publishing", error_code: "INTERNAL_ERROR" });
    expect(github.reviews).toHaveLength(1);

    await makeJobsReady();
    await worker.drain();

    const [run] = await runs();
    expect(run?.state).toBe("completed");
    expect(github.reviews).toHaveLength(1);
    expect(model.generateCalls).toBe(1);
    expect(Number((await findings())[0]?.github_comment_id)).toBe(10000);
  });

  it("publishes saved output without new model calls after an earlier publish failure", async () => {
    github.beforeCreateReview = () => {
      github.beforeCreateReview = undefined;
      throw new SafeError("GITHUB_RATE_LIMITED", true);
    };
    await reviewOnce();
    expect(github.reviews).toHaveLength(0);

    await makeJobsReady();
    await worker.drain();
    expect(github.reviews).toHaveLength(1);
    expect(model.generateCalls).toBe(1);
    expect(model.verifyCalls).toBe(1);
  });

  it("refuses model work when the monthly budget cannot cover it", async () => {
    await db.query(`INSERT INTO budget_months (workspace_id, month, spent_usd) VALUES ($1, to_char(now() at time zone 'utc', 'YYYY-MM'), 9)`, [WORKSPACE]);
    await reviewOnce();
    expect(model.generateCalls).toBe(0);
    expect((await runs())[0]).toMatchObject({ state: "failed", error_code: "MONTHLY_BUDGET_LIMIT" });
    expect(github.reviews).toHaveLength(0);
  });

  it("charges spend and releases the unused reservation", async () => {
    await reviewOnce();
    const [month] = await db.query(`SELECT spent_usd, reserved_usd FROM budget_months`);
    expect(Number(month?.reserved_usd)).toBe(0);
    // Two passes of 10k input at $4 and 1k output at $20 per million.
    expect(Number(month?.spent_usd)).toBeCloseTo(0.12);
    expect(Number((await runs())[0]?.cost_usd)).toBeCloseTo(0.12);
  });

  it("does not let a worker that lost its lease publish", async () => {
    await deliver();
    await worker.runNext();
    const job = (await claimJob(db))!;
    model.beforeGenerate = async () => {
      await db.query(`UPDATE jobs SET lease_token = 'someone-else'`);
    };
    await expect(runReview(deps, job)).rejects.toThrow("JOB_LEASE_LOST");
    expect(github.reviews).toHaveLength(0);
    expect((await runs())[0]?.state).toBe("publishing");
  });

  it("marks a PR with only excluded files as an explicit partial result", async () => {
    github.files.set(1, [{ path: "package-lock.json", status: "modified", patch: PATCH }]);
    await reviewOnce();
    const [run] = await runs();
    expect(run).toMatchObject({ state: "partial", summary: "No reviewable source in this pull request." });
    expect(run?.coverage).toMatchObject({ excluded: ["package-lock.json"] });
    expect(model.generateCalls).toBe(0);
  });

  it("reports partial coverage on an otherwise successful review", async () => {
    github.files.set(1, [
      { path: "src/average.ts", status: "modified", patch: PATCH },
      { path: "src/huge.ts", status: "modified" },
    ]);
    await reviewOnce();
    expect((await runs())[0]?.state).toBe("partial");
    expect(github.reviews[0]?.body).toContain("Partial coverage");
  });

  it("respects a monitoring pause that arrives during review", async () => {
    model.beforeGenerate = async () => {
      await db.query(`UPDATE repositories SET enabled = false`);
    };
    await reviewOnce();
    expect(github.reviews).toHaveLength(0);
    expect((await runs())[0]?.state).toBe("skipped");
    expect(await findings()).toHaveLength(0);
  });

  it("skips a queued run for a paused repository without model calls", async () => {
    await deliver();
    await worker.runNext();
    await db.query(`UPDATE repositories SET enabled = false`);
    await worker.drain();
    expect(model.generateCalls).toBe(0);
    expect((await runs())[0]?.state).toBe("skipped");
  });

  it("skips a run whose PR closed", async () => {
    await deliver();
    await worker.runNext();
    github.pullRequests[0]!.state = "closed";
    await worker.drain();
    expect((await runs())[0]?.state).toBe("skipped");
  });

  it("reassesses an earlier finding whose file left the latest diff", async () => {
    await reviewOnce();
    const [finding] = await findings();

    github.pullRequests[0]!.headSha = NEW_HEAD;
    github.files.set(1, [{ path: "src/new.ts", status: "added", patch: "@@ -0,0 +1 @@\n+export {};" }]);
    github.sources.set("src/new.ts", "export {};\n");
    github.sources.set("src/average.ts", "fixed source\n");
    model.findings = [];
    model.assessments = [{ id: finding!.id, outcome: "suspected_fixed", evidence: "guard restored" }];

    await deliver({ ...webhookPayload, action: "synchronize" });
    await worker.drain();

    expect(model.lastPrevious.map((item) => item.id)).toEqual([finding!.id]);
    expect(model.lastContext).toContain("fixed source");
    expect((await findings())[0]).toMatchObject({ outcome: "suspected_fixed", assessment: "guard restored" });
  });

  it("reassesses earlier findings even when the new diff has nothing reviewable", async () => {
    await reviewOnce();
    const [finding] = await findings();

    github.pullRequests[0]!.headSha = NEW_HEAD;
    github.files.set(1, [{ path: "package-lock.json", status: "modified", patch: PATCH }]);
    model.assessments = [{ id: finding!.id, outcome: "unverifiable", evidence: "not enough context" }];
    await deliver({ ...webhookPayload, action: "synchronize" });
    await worker.drain();

    expect(model.generateCalls).toBe(1);
    expect(model.verifyCalls).toBe(2);
    expect((await findings())[0]?.outcome).toBe("unverifiable");
  });

  it("keeps human decisions when model assessments arrive", async () => {
    await reviewOnce();
    const [finding] = await findings();
    await db.query(`UPDATE findings SET outcome = 'dismissed' WHERE id = $1`, [finding!.id]);

    github.pullRequests[0]!.headSha = NEW_HEAD;
    model.findings = [];
    model.assessments = [{ id: finding!.id, outcome: "suspected_fixed", evidence: "looks fixed" }];
    await deliver({ ...webhookPayload, action: "synchronize" });
    await worker.drain();

    expect((await findings())[0]?.outcome).toBe("dismissed");
  });

  it("ignores assessments for findings the run did not ask about", async () => {
    await reviewOnce();
    github.pullRequests[0]!.headSha = NEW_HEAD;
    model.assessments = [{ id: "unknown-id", outcome: "suspected_fixed", evidence: "invented" }];
    await deliver({ ...webhookPayload, action: "synchronize" });
    await worker.drain();
    expect((await findings())[0]?.outcome).toBe("open");
  });

  it("does not count a resolved thread as a fix", async () => {
    await reviewOnce();
    const [finding] = await findings();
    await deliver(
      {
        action: "resolved",
        installation: { id: 7 },
        repository: webhookPayload.repository,
        thread: { comments: [{ id: Number(finding!.github_comment_id) }] },
      },
      randomUUID(),
      "pull_request_review_thread",
    );
    await worker.drain();
    expect((await findings())[0]).toMatchObject({ thread_resolved: true, outcome: "open" });
  });

  it("removes forged markers, mentions, and secrets from model text", async () => {
    const leaked = "ghp_abcdefghijklmnopqrstuvwxyz012345";
    model.findings = [
      candidate({
        body: `Ping @maintainer about this defect <!-- reviewgate:run:forged --> with ${leaked} leaked.`,
      }),
    ];
    await reviewOnce();
    const body = github.reviews[0]!.comments[0]!.body;
    expect(body).not.toContain("reviewgate:run:forged");
    expect(body).not.toContain(leaked);
    expect(body).toContain("@​maintainer");
    expect(body).toContain("<!-- reviewgate:finding:");
  });

  it("never sends known secrets or excluded files to the model", async () => {
    deps.knownSecrets = ["configured-secret-value"];
    github.files.set(1, [
      { path: "src/average.ts", status: "modified", patch: PATCH },
      { path: ".env.production", status: "modified", patch: "@@ -0,0 +1 @@\n+TOKEN=abc" },
    ]);
    github.sources.set("src/average.ts", "uses configured-secret-value here\n");
    await reviewOnce();
    expect(model.lastContext).not.toContain("configured-secret-value");
    expect(model.lastContext).not.toContain("TOKEN=abc");
  });

  it("records usage from a failed generation and fails safely", async () => {
    model.failGenerate = () => new SafeError("MODEL_OUTPUT_INVALID", true);
    await reviewOnce();
    const [run] = await runs();
    expect(run).toMatchObject({ state: "failed", error_code: "MODEL_OUTPUT_INVALID" });
    expect(Number(run?.cost_usd)).toBeGreaterThan(0);
    expect(Number(run?.reserved_usd)).toBeGreaterThan(0);

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      await makeJobsReady();
      await worker.drain();
    }
    expect(model.generateCalls).toBe(MAX_ATTEMPTS);
    expect(Number((await runs())[0]?.reserved_usd)).toBe(0);
    expect((await db.query(`SELECT state FROM jobs WHERE kind = 'review'`))[0]?.state).toBe("dead");
  });

  it("fails clearly when the model is not configured", async () => {
    deps.model = null;
    await reviewOnce();
    expect((await runs())[0]).toMatchObject({ state: "failed", error_code: "ANTHROPIC_KEY_NOT_CONFIGURED" });
  });
});
