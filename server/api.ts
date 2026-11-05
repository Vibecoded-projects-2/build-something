import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "./config.ts";
import { recordAudit, type Db } from "./db.ts";
import { findingUpdateSchema, updateFinding } from "./findings.ts";
import { reviveJob } from "./jobs.ts";
import { DASHBOARD_WINDOWS, dashboard, pullRequestDetail, type DashboardWindow } from "./queries.ts";
import { enqueueSync } from "./service.ts";

export interface ApiDeps {
  config: AppConfig;
  db: Db;
  hasGitHubClient: boolean;
}

const repositoryUpdateSchema = z.object({ enabled: z.boolean() }).strict();
const RETRYABLE_RUN_STATES = new Set(["failed", "publishing"]);

export async function registerApiRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const { config, db, hasGitHubClient } = deps;
  const workspaceId = config.targetAccount;
  const session = { preHandler: app.requireSession };
  const mutation = { preHandler: app.requireMutation };

  app.get<{ Querystring: { days?: string } }>("/api/dashboard", session, async (request, reply) => {
    const days = Number(request.query.days ?? 30);
    if (!DASHBOARD_WINDOWS.includes(days as DashboardWindow)) {
      return reply.code(400).send({ ok: false, error: "BAD_REQUEST" });
    }
    return dashboard(db, config, days as DashboardWindow, hasGitHubClient);
  });

  app.get<{ Params: { id: string } }>("/api/prs/:id", session, async (request, reply) => {
    const detail = await pullRequestDetail(db, workspaceId, request.params.id);
    if (!detail) return reply.code(404).send({ ok: false, error: "NOT_FOUND" });
    return detail;
  });

  app.post("/api/sync", mutation, async () => {
    if (!hasGitHubClient) return { ok: false, error: "GITHUB_APP_NOT_CONFIGURED" };
    await enqueueSync({ config, db });
    await recordAudit(db, workspaceId, "sync.requested");
    return { ok: true };
  });

  app.patch<{ Params: { id: string } }>("/api/repos/:id", mutation, async (request, reply) => {
    const body = repositoryUpdateSchema.safeParse(request.body);
    if (!body.success || !/^\d+$/.test(request.params.id)) {
      return reply.code(400).send({ ok: false, error: "BAD_REQUEST" });
    }
    const updated = await db.query(
      `UPDATE repositories SET enabled = $3, updated_at = now()
       WHERE id = $1 AND workspace_id = $2 RETURNING id`,
      [request.params.id, workspaceId, body.data.enabled],
    );
    if (updated.length === 0) return reply.code(404).send({ ok: false, error: "NOT_FOUND" });
    await recordAudit(
      db,
      workspaceId,
      body.data.enabled ? "repository.resumed" : "repository.paused",
      request.params.id,
    );
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/retry", mutation, async (request, reply) => {
    const [run] = await db.query(
      `SELECT run.id, run.state, j.id AS job_id, j.state AS job_state
       FROM review_runs run
       LEFT JOIN jobs j ON j.dedup_key = 'review:' || run.id
       WHERE run.id = $1 AND run.workspace_id = $2`,
      [request.params.id, workspaceId],
    );
    if (!run) return reply.code(404).send({ ok: false, error: "NOT_FOUND" });
    if (
      !RETRYABLE_RUN_STATES.has(run.state) ||
      run.job_state !== "dead" ||
      !(await reviveJob(db, run.job_id))
    ) {
      return reply.code(409).send({ ok: false, error: "NOT_RETRYABLE" });
    }
    await recordAudit(db, workspaceId, "run.retried", run.id);
    return { ok: true };
  });

  app.patch<{ Params: { id: string } }>("/api/findings/:id", mutation, async (request, reply) => {
    const body = findingUpdateSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: "BAD_REQUEST" });
    const result = await updateFinding(db, workspaceId, request.params.id, body.data);
    if (!result.ok) {
      return reply.code(result.error === "NOT_FOUND" ? 404 : 422).send(result);
    }
    return result;
  });
}
