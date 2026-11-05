import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.ts";
import type { Db } from "./db.ts";
import { verifyWebhookSignature } from "./domain.ts";
import { enqueueJob } from "./jobs.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Larger deliveries are rejected and picked up by periodic reconciliation. */
const WEBHOOK_BODY_LIMIT_BYTES = 5 * 1024 * 1024;

const SUPPORTED_EVENTS = new Set([
  "pull_request",
  "pull_request_review_thread",
  "repository",
  "installation",
  "installation_repositories",
]);

/** Only what the worker needs. Raw deliveries are never stored. */
export interface NormalizedWebhook {
  event: string;
  action: string | null;
  installationId: number | null;
  repository: {
    id: number;
    fullName: string;
    private: boolean;
    archived: boolean;
  } | null;
  prNumber: number | null;
  threadCommentIds: number[];
}

export function normalizeWebhook(event: string, payload: any): NormalizedWebhook {
  const repository = payload.repository;
  return {
    event,
    action: typeof payload.action === "string" ? payload.action : null,
    installationId: payload.installation?.id ?? null,
    repository: repository
      ? {
          id: repository.id,
          fullName: repository.full_name,
          private: Boolean(repository.private),
          archived: Boolean(repository.archived),
        }
      : null,
    prNumber: payload.pull_request?.number ?? null,
    threadCommentIds: Array.isArray(payload.thread?.comments)
      ? payload.thread.comments.map((comment: { id: number }) => comment.id)
      : [],
  };
}

function ownerOf(payload: any): string | null {
  const login = payload.repository?.owner?.login ?? payload.installation?.account?.login;
  return typeof login === "string" ? login.toLowerCase() : null;
}

export async function registerWebhookRoutes(
  app: FastifyInstance,
  deps: { config: AppConfig; db: Db },
): Promise<void> {
  const { config, db } = deps;

  // Encapsulated so raw-byte parsing does not affect JSON parsing on /api routes.
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: WEBHOOK_BODY_LIMIT_BYTES },
      (_request, body, done) => done(null, body),
    );

    scope.post("/webhooks/github", async (request, reply) => {
      const secret = config.github.webhookSecret;
      if (!secret) {
        return reply.code(503).send({ ok: false, error: "GITHUB_APP_NOT_CONFIGURED" });
      }

      const rawBody = request.body;
      if (!Buffer.isBuffer(rawBody)) {
        return reply.code(415).send({ ok: false, error: "BAD_REQUEST" });
      }

      const signature = request.headers["x-hub-signature-256"];
      if (
        typeof signature !== "string" ||
        !verifyWebhookSignature(secret, rawBody, signature)
      ) {
        return reply.code(401).send({ ok: false, error: "INVALID_SIGNATURE" });
      }

      const delivery = request.headers["x-github-delivery"];
      const event = request.headers["x-github-event"];
      if (typeof delivery !== "string" || !UUID_PATTERN.test(delivery) || typeof event !== "string") {
        return reply.code(400).send({ ok: false, error: "BAD_REQUEST" });
      }

      if (event === "ping") return reply.code(200).send({ ok: true });
      if (!SUPPORTED_EVENTS.has(event)) {
        return reply.code(202).send({ ok: true, ignored: true });
      }

      let payload: any;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return reply.code(400).send({ ok: false, error: "BAD_REQUEST" });
      }

      const owner = ownerOf(payload);
      if (owner !== null && owner !== config.targetAccount) {
        return reply.code(202).send({ ok: true, ignored: true });
      }

      const normalized = normalizeWebhook(event, payload);
      const queued = await db.transaction(async (tx) => {
        const inserted = await tx.query(
          `INSERT INTO webhook_deliveries (guid, workspace_id, event, action)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (guid) DO NOTHING
           RETURNING guid`,
          [delivery.toLowerCase(), config.targetAccount, event, normalized.action],
        );
        if (inserted.length === 0) return false;
        await enqueueJob(tx, {
          workspaceId: config.targetAccount,
          dedupKey: `webhook:${delivery.toLowerCase()}`,
          kind: "webhook",
          payload: normalized,
        });
        return true;
      });

      return reply.code(202).send({ ok: true, queued });
    });
  });
}
