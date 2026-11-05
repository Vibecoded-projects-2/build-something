import type { Db, Queryable } from "./db.ts";
import { SafeError } from "./domain.ts";
import { estimateCostUsd, type TokenUsage } from "./reviewer.ts";

/** Budget months are UTC, for example `2026-11`. */
export function budgetMonth(date: Date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

export interface Reservation {
  workspaceId: string;
  runId: string;
  amountUsd: number;
  limitUsd: number;
  month?: string;
}

/**
 * Admits a reservation only if spent + reserved + amount fits the monthly budget.
 * A run that already holds a reservation keeps it, because the amount covers retries.
 * This is an internal estimate, not a provider-enforced billing cap.
 */
export async function reserveBudget(db: Db, reservation: Reservation): Promise<void> {
  const { workspaceId, runId, amountUsd, limitUsd } = reservation;
  const month = reservation.month ?? budgetMonth();

  await db.transaction(async (tx) => {
    const [run] = await tx.query(`SELECT reserved_usd FROM review_runs WHERE id = $1 FOR UPDATE`, [runId]);
    if (Number(run?.reserved_usd ?? 0) > 0) return;

    await tx.query(
      `INSERT INTO budget_months (workspace_id, month) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [workspaceId, month],
    );
    const [row] = await tx.query(
      `SELECT spent_usd, reserved_usd FROM budget_months
       WHERE workspace_id = $1 AND month = $2 FOR UPDATE`,
      [workspaceId, month],
    );
    if (Number(row?.spent_usd) + Number(row?.reserved_usd) + amountUsd > limitUsd) {
      throw new SafeError("MONTHLY_BUDGET_LIMIT");
    }
    await tx.query(
      `UPDATE budget_months SET reserved_usd = reserved_usd + $3 WHERE workspace_id = $1 AND month = $2`,
      [workspaceId, month, amountUsd],
    );
    await tx.query(`UPDATE review_runs SET reserved_usd = $2, budget_month = $3 WHERE id = $1`, [
      runId,
      amountUsd,
      month,
    ]);
  });
}

function addUsage(existing: Partial<TokenUsage> | null, usage: TokenUsage): TokenUsage {
  return {
    inputTokens: (existing?.inputTokens ?? 0) + usage.inputTokens,
    outputTokens: (existing?.outputTokens ?? 0) + usage.outputTokens,
    cacheReadTokens: (existing?.cacheReadTokens ?? 0) + usage.cacheReadTokens,
    cacheWriteTokens: (existing?.cacheWriteTokens ?? 0) + usage.cacheWriteTokens,
  };
}

/** Records actual usage, moving the matching amount from reserved to spent. */
export async function chargeUsage(db: Db, runId: string, usage: TokenUsage): Promise<void> {
  await db.transaction(async (tx) => {
    const [run] = await tx.query(
      `SELECT workspace_id, model, budget_month, reserved_usd, usage FROM review_runs
       WHERE id = $1 FOR UPDATE`,
      [runId],
    );
    if (!run) return;

    const cost = estimateCostUsd(run.model, usage);
    const consumed = Math.min(cost, Number(run.reserved_usd));
    const month = run.budget_month ?? budgetMonth();

    await tx.query(
      `INSERT INTO budget_months (workspace_id, month) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [run.workspace_id, month],
    );
    await tx.query(
      `UPDATE budget_months
       SET spent_usd = spent_usd + $3, reserved_usd = GREATEST(reserved_usd - $4, 0)
       WHERE workspace_id = $1 AND month = $2`,
      [run.workspace_id, month, cost, consumed],
    );
    await tx.query(
      `UPDATE review_runs
       SET cost_usd = cost_usd + $2, reserved_usd = reserved_usd - $3, usage = $4, budget_month = $5
       WHERE id = $1`,
      [runId, cost, consumed, JSON.stringify(addUsage(run.usage, usage)), month],
    );
  });
}

async function releaseWithin(tx: Queryable, runId: string): Promise<void> {
  const [run] = await tx.query(
    `SELECT workspace_id, budget_month, reserved_usd FROM review_runs WHERE id = $1 FOR UPDATE`,
    [runId],
  );
  const reserved = Number(run?.reserved_usd ?? 0);
  if (!run || reserved === 0) return;
  await tx.query(
    `UPDATE budget_months SET reserved_usd = GREATEST(reserved_usd - $3, 0)
     WHERE workspace_id = $1 AND month = $2`,
    [run.workspace_id, run.budget_month, reserved],
  );
  await tx.query(`UPDATE review_runs SET reserved_usd = 0 WHERE id = $1`, [runId]);
}

/** Returns whatever a finished run did not use. */
export async function releaseReservation(db: Db, runId: string): Promise<void> {
  await db.transaction((tx) => releaseWithin(tx, runId));
}

/**
 * Releases money held by runs whose job can no longer make progress, such as a job
 * that died because its worker crashed and never reported back.
 */
export async function releaseAbandonedReservations(db: Db, workspaceId: string): Promise<void> {
  const rows = await db.query(
    `SELECT r.id FROM review_runs r
     JOIN jobs j ON j.dedup_key = 'review:' || r.id
     WHERE r.workspace_id = $1 AND r.reserved_usd > 0 AND j.state IN ('dead', 'completed')`,
    [workspaceId],
  );
  for (const row of rows) await releaseReservation(db, row.id);
}
