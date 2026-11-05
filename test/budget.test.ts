import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  budgetMonth,
  chargeUsage,
  releaseAbandonedReservations,
  releaseReservation,
  reserveBudget,
} from "../server/budget.ts";
import type { Db } from "../server/db.ts";
import { enqueueJob } from "../server/jobs.ts";
import { testDb, WORKSPACE } from "./helpers.ts";

const MONTH = "2026-11";
const usage = { inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
// 100k input at $4 plus 10k output at $20 per million.
const USAGE_COST = 0.6;

async function seedRun(db: Db, id: string): Promise<void> {
  await db.query(
    `INSERT INTO installations (id, workspace_id, account_id, account_login, repository_selection)
     VALUES (1, $1, 1, 'acme', 'all') ON CONFLICT DO NOTHING`,
    [WORKSPACE],
  );
  await db.query(
    `INSERT INTO repositories (id, workspace_id, installation_id, full_name)
     VALUES (2, $1, 1, 'acme/app') ON CONFLICT DO NOTHING`,
    [WORKSPACE],
  );
  await db.query(
    `INSERT INTO pull_requests (id, repo_id, workspace_id, number, title, author, url, state, head_sha, base_sha, opened_at)
     VALUES ('2:1', 2, $1, 1, 't', 'a', 'u', 'open', 'h', 'b', now()) ON CONFLICT DO NOTHING`,
    [WORKSPACE],
  );
  await db.query(
    `INSERT INTO review_runs (id, pr_id, workspace_id, head_sha, base_sha, model, prompt_version)
     VALUES ($1, '2:1', $2, $1, 'b', 'claude-opus-5-5', 'v1')`,
    [id, WORKSPACE],
  );
}

describe("monthly budget", () => {
  let db: Db;

  beforeEach(async () => {
    db = await testDb();
    await seedRun(db, "run-1");
    await seedRun(db, "run-2");
  });

  afterEach(async () => {
    await db.close();
  });

  const reserve = (runId: string, amountUsd: number, limitUsd = 10) =>
    reserveBudget(db, { workspaceId: WORKSPACE, runId, amountUsd, limitUsd, month: MONTH });

  const month = async () => {
    const [row] = await db.query(`SELECT spent_usd, reserved_usd FROM budget_months WHERE month = $1`, [MONTH]);
    return { spent: Number(row?.spent_usd), reserved: Number(row?.reserved_usd) };
  };

  const run = async (id: string) => {
    const [row] = await db.query(`SELECT cost_usd, reserved_usd, usage FROM review_runs WHERE id = $1`, [id]);
    return { cost: Number(row?.cost_usd), reserved: Number(row?.reserved_usd), usage: row?.usage };
  };

  it("uses UTC months", () => {
    expect(budgetMonth(new Date("2026-11-30T23:59:59-08:00"))).toBe("2026-12");
  });

  it("admits reservations that fit and rejects those that do not", async () => {
    await reserve("run-1", 6);
    await expect(reserve("run-2", 5)).rejects.toThrow("MONTHLY_BUDGET_LIMIT");
    expect(await month()).toEqual({ spent: 0, reserved: 6 });
    expect((await run("run-2")).reserved).toBe(0);
  });

  it("does not reserve twice for a retried run", async () => {
    await reserve("run-1", 6);
    await reserve("run-1", 6);
    expect(await month()).toEqual({ spent: 0, reserved: 6 });
  });

  it("moves actual cost from reserved to spent and adds usage up", async () => {
    await reserve("run-1", 3);
    await chargeUsage(db, "run-1", usage);
    await chargeUsage(db, "run-1", usage);

    expect((await month()).spent).toBeCloseTo(2 * USAGE_COST);
    expect((await month()).reserved).toBeCloseTo(3 - 2 * USAGE_COST);
    const after = await run("run-1");
    expect(after.cost).toBeCloseTo(2 * USAGE_COST);
    expect(after.usage).toMatchObject({ inputTokens: 200_000, outputTokens: 20_000 });
  });

  it("records cost beyond the reservation without going negative", async () => {
    await reserve("run-1", 0.5);
    await chargeUsage(db, "run-1", usage);
    expect(await month()).toEqual({ spent: USAGE_COST, reserved: 0 });
    expect((await run("run-1")).reserved).toBe(0);
  });

  it("releases the unused reservation once", async () => {
    await reserve("run-1", 3);
    await chargeUsage(db, "run-1", usage);
    await releaseReservation(db, "run-1");
    await releaseReservation(db, "run-1");
    expect(await month()).toEqual({ spent: USAGE_COST, reserved: 0 });
  });

  it("counts earlier spend against new reservations", async () => {
    await db.query(
      `INSERT INTO budget_months (workspace_id, month, spent_usd) VALUES ($1, $2, 9)`,
      [WORKSPACE, MONTH],
    );
    await expect(reserve("run-1", 2)).rejects.toThrow("MONTHLY_BUDGET_LIMIT");
    await expect(reserve("run-1", 1)).resolves.toBeUndefined();
  });

  it("releases reservations held by dead jobs but not active ones", async () => {
    await reserve("run-1", 2);
    await reserve("run-2", 2);
    await enqueueJob(db, { workspaceId: WORKSPACE, dedupKey: "review:run-1", kind: "review", payload: {} });
    await enqueueJob(db, { workspaceId: WORKSPACE, dedupKey: "review:run-2", kind: "review", payload: {} });
    await db.query(`UPDATE jobs SET state = 'dead' WHERE dedup_key = 'review:run-1'`);

    await releaseAbandonedReservations(db, WORKSPACE);
    expect((await run("run-1")).reserved).toBe(0);
    expect((await run("run-2")).reserved).toBe(2);
  });
});
