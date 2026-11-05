import { randomUUID } from "node:crypto";
import type { Db, Queryable } from "./db.ts";
import { SafeError, type SafeErrorCode } from "./domain.ts";

export type JobKind = "webhook" | "sync" | "review";

export const MAX_ATTEMPTS = 3;
export const LEASE_SECONDS = 300;
const BASE_BACKOFF_SECONDS = 15;
const MAX_BACKOFF_SECONDS = 300;

export interface Job {
  id: string;
  workspaceId: string;
  kind: JobKind;
  payload: any;
  attempts: number;
  leaseToken: string;
}

export interface NewJob {
  workspaceId: string;
  dedupKey: string;
  kind: JobKind;
  payload: unknown;
}

/** Returns the new job ID, or null when the dedup key already exists. */
export async function enqueueJob(db: Queryable, job: NewJob): Promise<string | null> {
  const rows = await db.query(
    `INSERT INTO jobs (id, workspace_id, dedup_key, kind, payload)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (dedup_key) DO NOTHING
     RETURNING id`,
    [randomUUID(), job.workspaceId, job.dedupKey, job.kind, JSON.stringify(job.payload)],
  );
  return rows[0]?.id ?? null;
}

/**
 * Claims the oldest eligible job, or the named job if it is eligible.
 * A running job becomes eligible again once its lease expires, which is how
 * work held by a crashed worker is recovered.
 */
export async function claimJob(db: Db, jobId?: string): Promise<Job | null> {
  return db.transaction(async (tx) => {
    await tx.query(
      `UPDATE jobs
       SET state = 'dead', error_code = 'JOB_LEASE_LOST', lease_token = NULL, lease_expires_at = NULL
       WHERE state = 'running' AND lease_expires_at < now() AND attempts >= $1`,
      [MAX_ATTEMPTS],
    );

    const candidates = await tx.query(
      `SELECT id FROM jobs
       WHERE attempts < $1
         AND ($2::text IS NULL OR id = $2)
         AND ((state = 'pending' AND available_at <= now())
              OR (state = 'running' AND lease_expires_at < now()))
       ORDER BY available_at, created_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [MAX_ATTEMPTS, jobId ?? null],
    );
    const candidate = candidates[0];
    if (!candidate) return null;

    const leaseToken = randomUUID();
    const claimed = await tx.query(
      `UPDATE jobs
       SET state = 'running',
           attempts = attempts + 1,
           lease_token = $2,
           lease_expires_at = now() + make_interval(secs => $3)
       WHERE id = $1
       RETURNING id, workspace_id, kind, payload, attempts`,
      [candidate.id, leaseToken, LEASE_SECONDS],
    );
    const row = claimed[0]!;
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      kind: row.kind,
      payload: row.payload,
      attempts: row.attempts,
      leaseToken,
    };
  });
}

/** Extends a lease the caller still owns. Returns false once it has been lost. */
export async function renewLease(db: Queryable, job: Job): Promise<boolean> {
  const rows = await db.query(
    `UPDATE jobs SET lease_expires_at = now() + make_interval(secs => $3)
     WHERE id = $1 AND lease_token = $2 AND state = 'running'
     RETURNING id`,
    [job.id, job.leaseToken, LEASE_SECONDS],
  );
  return rows.length > 0;
}

/** Throws unless the caller holds a current lease. Call before external side effects. */
export async function assertLease(db: Queryable, job: Job): Promise<void> {
  const rows = await db.query(
    `SELECT id FROM jobs
     WHERE id = $1 AND lease_token = $2 AND state = 'running' AND lease_expires_at > now()`,
    [job.id, job.leaseToken],
  );
  if (rows.length === 0) throw new SafeError("JOB_LEASE_LOST");
}

export async function completeJob(db: Queryable, job: Job): Promise<void> {
  await db.query(
    `UPDATE jobs
     SET state = 'completed', lease_token = NULL, lease_expires_at = NULL, error_code = NULL
     WHERE id = $1 AND lease_token = $2`,
    [job.id, job.leaseToken],
  );
}

export function backoffSeconds(attempt: number): number {
  return Math.min(BASE_BACKOFF_SECONDS * 2 ** (attempt - 1), MAX_BACKOFF_SECONDS);
}

/** Schedules a retry, or marks the job dead when it cannot be retried. */
export async function failJob(
  db: Queryable,
  job: Job,
  errorCode: SafeErrorCode,
  retryable: boolean,
): Promise<"retrying" | "dead"> {
  const willRetry = retryable && job.attempts < MAX_ATTEMPTS;
  await db.query(
    `UPDATE jobs
     SET state = $3,
         error_code = $4,
         lease_token = NULL,
         lease_expires_at = NULL,
         available_at = now() + make_interval(secs => $5),
         sqs_enqueued_at = NULL
     WHERE id = $1 AND lease_token = $2`,
    [job.id, job.leaseToken, willRetry ? "pending" : "dead", errorCode, backoffSeconds(job.attempts)],
  );
  return willRetry ? "retrying" : "dead";
}

/** Returns a dead job to the queue with a fresh attempt budget. */
export async function reviveJob(db: Queryable, jobId: string): Promise<boolean> {
  const rows = await db.query(
    `UPDATE jobs
     SET state = 'pending', attempts = 0, available_at = now(), error_code = NULL, sqs_enqueued_at = NULL
     WHERE id = $1 AND state = 'dead'
     RETURNING id`,
    [jobId],
  );
  return rows.length > 0;
}
