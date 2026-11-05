import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../server/db.ts";
import {
  assertLease,
  backoffSeconds,
  claimJob,
  completeJob,
  enqueueJob,
  failJob,
  MAX_ATTEMPTS,
  renewLease,
  reviveJob,
} from "../server/jobs.ts";
import { testDb, WORKSPACE } from "./helpers.ts";

const job = (dedupKey = "key") => ({
  workspaceId: WORKSPACE,
  dedupKey,
  kind: "sync" as const,
  payload: { hello: "world" },
});

const expireLeases = (db: Db) =>
  db.query(`UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE state = 'running'`);
const makeAvailable = (db: Db) => db.query(`UPDATE jobs SET available_at = now()`);
const stateOf = async (db: Db, id: string) =>
  (await db.query(`SELECT state, error_code FROM jobs WHERE id = $1`, [id]))[0];

describe("job queue", () => {
  let db: Db;

  beforeEach(async () => {
    db = await testDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it("deduplicates on the dedup key", async () => {
    expect(await enqueueJob(db, job())).toEqual(expect.any(String));
    expect(await enqueueJob(db, job())).toBeNull();
  });

  it("claims one job at a time and preserves its payload", async () => {
    await enqueueJob(db, job());
    const claimed = await claimJob(db);
    expect(claimed).toMatchObject({ kind: "sync", payload: { hello: "world" }, attempts: 1 });
    expect(await claimJob(db)).toBeNull();
  });

  it("claims a specific job only when it is eligible", async () => {
    const first = (await enqueueJob(db, job("a")))!;
    const second = (await enqueueJob(db, job("b")))!;
    expect((await claimJob(db, second))?.id).toBe(second);
    expect(await claimJob(db, second)).toBeNull();
    expect((await claimJob(db, first))?.id).toBe(first);
  });

  it("recovers a job whose lease expired and fences off the old owner", async () => {
    await enqueueJob(db, job());
    const stale = (await claimJob(db))!;
    await expireLeases(db);

    await expect(assertLease(db, stale)).rejects.toThrow("JOB_LEASE_LOST");

    const replacement = (await claimJob(db))!;
    expect(replacement.id).toBe(stale.id);
    expect(replacement.attempts).toBe(2);
    expect(await renewLease(db, stale)).toBe(false);

    await completeJob(db, stale);
    expect(await stateOf(db, stale.id)).toMatchObject({ state: "running" });
    await expect(assertLease(db, replacement)).resolves.toBeUndefined();
  });

  it("renews a lease the worker still owns", async () => {
    await enqueueJob(db, job());
    const claimed = (await claimJob(db))!;
    await expireLeases(db);
    expect(await renewLease(db, claimed)).toBe(true);
    await expect(assertLease(db, claimed)).resolves.toBeUndefined();
  });

  it("completes a job", async () => {
    await enqueueJob(db, job());
    const claimed = (await claimJob(db))!;
    await completeJob(db, claimed);
    expect(await stateOf(db, claimed.id)).toMatchObject({ state: "completed" });
    expect(await claimJob(db)).toBeNull();
  });

  it("backs off retryable failures and dies after the last attempt", async () => {
    const id = (await enqueueJob(db, job()))!;

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      const claimed = (await claimJob(db))!;
      expect(await failJob(db, claimed, "GITHUB_RATE_LIMITED", true)).toBe("retrying");
      expect(await claimJob(db)).toBeNull();
      await makeAvailable(db);
    }

    const last = (await claimJob(db))!;
    expect(await failJob(db, last, "GITHUB_RATE_LIMITED", true)).toBe("dead");
    expect(await stateOf(db, id)).toEqual({ state: "dead", error_code: "GITHUB_RATE_LIMITED" });
  });

  it("does not retry non-retryable failures", async () => {
    const id = (await enqueueJob(db, job()))!;
    expect(await failJob(db, (await claimJob(db))!, "CONTEXT_TOKEN_LIMIT", false)).toBe("dead");
    expect(await stateOf(db, id)).toMatchObject({ state: "dead" });
  });

  it("marks a repeatedly crashing job dead instead of claiming it forever", async () => {
    const id = (await enqueueJob(db, job()))!;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      expect(await claimJob(db)).not.toBeNull();
      await expireLeases(db);
    }
    expect(await claimJob(db)).toBeNull();
    expect(await stateOf(db, id)).toEqual({ state: "dead", error_code: "JOB_LEASE_LOST" });
  });

  it("revives only dead jobs", async () => {
    const id = (await enqueueJob(db, job()))!;
    expect(await reviveJob(db, id)).toBe(false);
    await failJob(db, (await claimJob(db))!, "INTERNAL_ERROR", false);
    expect(await reviveJob(db, id)).toBe(true);
    expect(await claimJob(db)).toMatchObject({ id, attempts: 1 });
  });

  it("bounds exponential backoff", () => {
    expect(backoffSeconds(1)).toBe(15);
    expect(backoffSeconds(2)).toBe(30);
    expect(backoffSeconds(20)).toBe(300);
  });
});
