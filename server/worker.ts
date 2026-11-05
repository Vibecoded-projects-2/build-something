import { setTimeout as sleep } from "node:timers/promises";
import type { Db } from "./db.ts";
import { safeErrorCode, SafeError } from "./domain.ts";
import {
  claimJob,
  completeJob,
  failJob,
  LEASE_SECONDS,
  renewLease,
  type Job,
  type JobKind,
} from "./jobs.ts";

export type JobHandler = (job: Job) => Promise<void>;

export interface WakeupMessage {
  jobId: string;
  receipt: string;
}

/** Queue transport. It only carries job IDs; the database remains the record of work. */
export interface Wakeups {
  send(jobId: string): Promise<void>;
  receive(): Promise<WakeupMessage[]>;
  extendVisibility(receipt: string, seconds: number): Promise<void>;
  remove(receipt: string): Promise<void>;
}

export interface WorkerOptions {
  db: Db;
  handlers: Record<JobKind, JobHandler>;
  wakeups?: Wakeups | null;
  /** Called periodically so reconciliation runs even with no webhooks. */
  onTick?: () => Promise<void>;
  onError?: (error: unknown) => void;
  pollMs?: number;
  heartbeatMs?: number;
  tickMs?: number;
}

const REPUBLISH_AFTER_SECONDS = 300;
const PUBLISH_BATCH = 50;

/** Sends a wakeup for eligible work whose message is missing or old. */
export async function publishWakeups(db: Db, wakeups: Wakeups): Promise<number> {
  const rows = await db.query(
    `SELECT id FROM jobs
     WHERE ((state = 'pending' AND available_at <= now())
            OR (state = 'running' AND lease_expires_at < now()))
       AND (sqs_enqueued_at IS NULL
            OR sqs_enqueued_at < now() - make_interval(secs => $1))
     ORDER BY available_at
     LIMIT $2`,
    [REPUBLISH_AFTER_SECONDS, PUBLISH_BATCH],
  );
  for (const row of rows) {
    await wakeups.send(row.id);
    await db.query(`UPDATE jobs SET sqs_enqueued_at = now() WHERE id = $1`, [row.id]);
  }
  return rows.length;
}

export class Worker {
  private stopped = true;
  private loopPromise: Promise<void> | null = null;
  private lastTick = 0;
  private readonly pollMs: number;
  private readonly heartbeatMs: number;
  private readonly tickMs: number;

  constructor(private readonly options: WorkerOptions) {
    this.pollMs = options.pollMs ?? 2_000;
    this.heartbeatMs = options.heartbeatMs ?? 20_000;
    this.tickMs = options.tickMs ?? 30_000;
  }

  /** Claims and runs one job from the database. Returns false when none is ready. */
  async runNext(): Promise<boolean> {
    const job = await claimJob(this.options.db);
    if (!job) return false;
    await this.execute(job);
    return true;
  }

  /** Runs every job that is ready now. Useful for tests and one-off tools. */
  async drain(): Promise<void> {
    while (await this.runNext()) {
      // Keep going until the queue has nothing ready.
    }
  }

  async execute(job: Job, receipt?: string): Promise<void> {
    const { db, handlers } = this.options;
    const heartbeat = setInterval(() => {
      void this.beat(job, receipt).catch((error) => this.options.onError?.(error));
    }, this.heartbeatMs);
    heartbeat.unref();

    try {
      await handlers[job.kind](job);
      await completeJob(db, job);
    } catch (error) {
      // A lost lease means another worker owns the job. failJob then has no effect.
      const retryable = error instanceof SafeError ? error.retryable : true;
      await failJob(db, job, safeErrorCode(error), retryable);
      this.options.onError?.(error);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async beat(job: Job, receipt?: string): Promise<void> {
    const renewed = await renewLease(this.options.db, job);
    if (renewed && receipt) {
      await this.options.wakeups?.extendVisibility(receipt, LEASE_SECONDS);
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loopPromise;
    this.loopPromise = null;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.tick();
        const worked = this.options.wakeups
          ? await this.runFromQueue(this.options.wakeups)
          : await this.runNext();
        if (!worked) await sleep(this.pollMs);
      } catch (error) {
        this.options.onError?.(error);
        await sleep(this.pollMs);
      }
    }
  }

  private async tick(): Promise<void> {
    if (Date.now() - this.lastTick < this.tickMs) return;
    this.lastTick = Date.now();
    await this.options.onTick?.();
  }

  private async runFromQueue(wakeups: Wakeups): Promise<boolean> {
    await publishWakeups(this.options.db, wakeups);
    const messages = await wakeups.receive();
    for (const message of messages) {
      const job = await claimJob(this.options.db, message.jobId);
      if (job) await this.execute(job, message.receipt);
      await wakeups.remove(message.receipt);
    }
    return messages.length > 0;
  }
}
