import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../server/db.ts";
import { SafeError } from "../server/domain.ts";
import { enqueueJob, type Job } from "../server/jobs.ts";
import { publishWakeups, Worker, type WakeupMessage, type Wakeups } from "../server/worker.ts";
import { testDb, WORKSPACE } from "./helpers.ts";

class FakeWakeups implements Wakeups {
  sent: string[] = [];
  inbox: WakeupMessage[] = [];
  removed: string[] = [];
  extended: string[] = [];

  async send(jobId: string) {
    this.sent.push(jobId);
    this.inbox.push({ jobId, receipt: `receipt-${jobId}` });
  }
  async receive() {
    return this.inbox.splice(0);
  }
  async extendVisibility(receipt: string) {
    this.extended.push(receipt);
  }
  async remove(receipt: string) {
    this.removed.push(receipt);
  }
}

const newJob = (dedupKey: string) => ({
  workspaceId: WORKSPACE,
  dedupKey,
  kind: "sync" as const,
  payload: {},
});

describe("Worker", () => {
  let db: Db;
  let seen: Job[];

  beforeEach(async () => {
    db = await testDb();
    seen = [];
  });

  afterEach(async () => {
    await db.close();
  });

  const worker = (
    handler: (job: Job) => Promise<void> = async (job) => {
      seen.push(job);
    },
    extra: Partial<ConstructorParameters<typeof Worker>[0]> = {},
  ) =>
    new Worker({
      db,
      handlers: { sync: handler, webhook: handler, review: handler },
      pollMs: 5,
      ...extra,
    });

  const job = async (id: string) =>
    (await db.query(`SELECT state, attempts, error_code FROM jobs WHERE id = $1`, [id]))[0];

  it("runs a job and marks it complete", async () => {
    const id = (await enqueueJob(db, newJob("a")))!;
    expect(await worker().runNext()).toBe(true);
    expect(seen).toHaveLength(1);
    expect(await job(id)).toMatchObject({ state: "completed", attempts: 1 });
    expect(await worker().runNext()).toBe(false);
  });

  it("retries unexpected errors with a sanitized code", async () => {
    const id = (await enqueueJob(db, newJob("a")))!;
    await worker(async () => {
      throw new Error("secret provider detail");
    }).runNext();
    expect(await job(id)).toEqual({ state: "pending", attempts: 1, error_code: "INTERNAL_ERROR" });
  });

  it("does not retry a non-retryable safe error", async () => {
    const id = (await enqueueJob(db, newJob("a")))!;
    await worker(async () => {
      throw new SafeError("CONTEXT_TOKEN_LIMIT");
    }).runNext();
    expect(await job(id)).toMatchObject({ state: "dead", error_code: "CONTEXT_TOKEN_LIMIT" });
  });

  it("keeps a long job leased with heartbeats", async () => {
    const id = (await enqueueJob(db, newJob("a")))!;
    await db.query(`UPDATE jobs SET lease_expires_at = now()`);
    await worker(
      async () => {
        await db.query(`UPDATE jobs SET lease_expires_at = now() - interval '1 minute'`);
        await sleep(40);
        const [row] = await db.query(`SELECT lease_expires_at > now() AS leased FROM jobs`);
        expect(row?.leased).toBe(true);
      },
      { heartbeatMs: 5 },
    ).runNext();
    expect(await job(id)).toMatchObject({ state: "completed" });
  });

  it("drains all ready jobs", async () => {
    await enqueueJob(db, newJob("a"));
    await enqueueJob(db, newJob("b"));
    await worker().drain();
    expect(seen).toHaveLength(2);
  });

  it("runs through the loop and stops cleanly", async () => {
    await enqueueJob(db, newJob("a"));
    let ticks = 0;
    const instance = worker(undefined, {
      onTick: async () => {
        ticks += 1;
      },
    });
    instance.start();
    while (seen.length === 0) await sleep(5);
    await instance.stop();
    expect(ticks).toBeGreaterThan(0);
  });

  it("publishes wakeups once until they age out", async () => {
    const wakeups = new FakeWakeups();
    const id = (await enqueueJob(db, newJob("a")))!;
    expect(await publishWakeups(db, wakeups)).toBe(1);
    expect(await publishWakeups(db, wakeups)).toBe(0);

    await db.query(`UPDATE jobs SET sqs_enqueued_at = now() - interval '6 minutes'`);
    expect(await publishWakeups(db, wakeups)).toBe(1);
    expect(wakeups.sent).toEqual([id, id]);
  });

  it("runs queued work and removes the message", async () => {
    const wakeups = new FakeWakeups();
    const id = (await enqueueJob(db, newJob("a")))!;
    const instance = worker(undefined, { wakeups });
    instance.start();
    while (wakeups.removed.length === 0) await sleep(5);
    await instance.stop();
    expect(seen.map((item) => item.id)).toEqual([id]);
    expect(wakeups.removed).toEqual([`receipt-${id}`]);
  });

  it("removes a message for a job that is no longer eligible", async () => {
    const wakeups = new FakeWakeups();
    wakeups.inbox.push({ jobId: "missing", receipt: "stale" });
    const instance = worker(undefined, { wakeups });
    instance.start();
    while (wakeups.removed.length === 0) await sleep(5);
    await instance.stop();
    expect(seen).toHaveLength(0);
  });
});
