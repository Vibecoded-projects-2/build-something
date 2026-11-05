import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.ts";
import type { Db, Row } from "./db.ts";
import { PROMPT_VERSION, pullRequestId, SafeError } from "./domain.ts";
import {
  splitFullName,
  type GitHubGateway,
  type InstallationInfo,
  type PullRequestInfo,
  type RepoRef,
} from "./github.ts";
import { enqueueJob } from "./jobs.ts";
import type { NormalizedWebhook } from "./webhooks.ts";

export const SYNC_INTERVAL_MS = 5 * 60 * 1000;

const REVIEW_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review", "edited"]);

export interface ServiceDeps {
  config: AppConfig;
  db: Db;
  github: GitHubGateway | null;
}

function requireGitHub(deps: ServiceDeps): GitHubGateway {
  if (!deps.github) throw new SafeError("GITHUB_APP_NOT_CONFIGURED");
  return deps.github;
}

function assertInstallationOwner(config: AppConfig, installation: InstallationInfo): void {
  if (installation.accountLogin.toLowerCase() !== config.targetAccount) {
    throw new SafeError("INSTALLATION_ACCOUNT_MISMATCH");
  }
}

function assertRepositoryOwner(config: AppConfig, fullName: string): void {
  if (splitFullName(fullName).owner.toLowerCase() !== config.targetAccount) {
    throw new SafeError("REPOSITORY_ACCOUNT_MISMATCH");
  }
}

export function repoRef(row: { installation_id: unknown; full_name: string }): RepoRef {
  return { installationId: Number(row.installation_id), ...splitFullName(row.full_name) };
}

/** Refreshes installations and repositories. Monitoring toggles are preserved. */
export async function syncInventory(deps: ServiceDeps): Promise<void> {
  const github = requireGitHub(deps);
  const { config, db } = deps;
  const workspaceId = config.targetAccount;

  const installations = (await github.listInstallations()).filter(
    (installation) => installation.accountLogin.toLowerCase() === workspaceId,
  );

  await db.query(
    `UPDATE installations SET active = false, updated_at = now()
     WHERE workspace_id = $1 AND NOT (id = ANY($2::bigint[]))`,
    [workspaceId, installations.map((installation) => installation.id)],
  );

  for (const installation of installations) {
    assertInstallationOwner(config, installation);
    await db.query(
      `INSERT INTO installations (id, workspace_id, account_id, account_login, repository_selection, active)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (id) DO UPDATE SET
         account_id = EXCLUDED.account_id,
         account_login = EXCLUDED.account_login,
         repository_selection = EXCLUDED.repository_selection,
         active = true,
         updated_at = now()`,
      [
        installation.id,
        workspaceId,
        installation.accountId,
        installation.accountLogin,
        installation.repositorySelection,
      ],
    );

    const repositories = await github.listRepositories(installation.id);
    for (const repository of repositories) {
      assertRepositoryOwner(config, repository.fullName);
      await db.query(
        `INSERT INTO repositories (id, workspace_id, installation_id, full_name, private, archived, accessible)
         VALUES ($1, $2, $3, $4, $5, $6, true)
         ON CONFLICT (id) DO UPDATE SET
           installation_id = EXCLUDED.installation_id,
           full_name = EXCLUDED.full_name,
           private = EXCLUDED.private,
           archived = EXCLUDED.archived,
           accessible = true,
           updated_at = now()`,
        [
          repository.id,
          workspaceId,
          installation.id,
          repository.fullName,
          repository.private,
          repository.archived,
        ],
      );
    }

    await db.query(
      `UPDATE repositories SET accessible = false, updated_at = now()
       WHERE installation_id = $1 AND NOT (id = ANY($2::bigint[]))`,
      [installation.id, repositories.map((repository) => repository.id)],
    );
  }
}

/** Finds open PRs for monitored repositories and schedules any unreviewed commit pair. */
export async function syncPullRequests(deps: ServiceDeps): Promise<void> {
  const github = requireGitHub(deps);
  const { config, db } = deps;
  const workspaceId = config.targetAccount;

  const repositories = await db.query(
    `SELECT r.id, r.installation_id, r.full_name
     FROM repositories r
     JOIN installations i ON i.id = r.installation_id
     WHERE r.workspace_id = $1 AND r.enabled AND r.accessible AND NOT r.archived AND i.active`,
    [workspaceId],
  );

  for (const repository of repositories) {
    const repoId = Number(repository.id);
    const ref = repoRef(repository as any);
    try {
      const open = await github.listOpenPullRequests(ref);
      const seen = new Set<number>();
      for (const pr of open) {
        seen.add(pr.number);
        const prId = await upsertPullRequest(db, workspaceId, repoId, pr);
        await scheduleReview(deps, prId);
      }

      const known = await db.query(
        `SELECT id, number FROM pull_requests WHERE repo_id = $1 AND state = 'open'`,
        [repoId],
      );
      for (const pr of known) {
        if (seen.has(pr.number)) continue;
        const current = await github.getPullRequest(ref, pr.number);
        if (current) {
          await upsertPullRequest(db, workspaceId, repoId, current);
        } else {
          await db.query(
            `UPDATE pull_requests SET state = 'closed', updated_at = now() WHERE id = $1`,
            [pr.id],
          );
        }
      }
    } catch (error) {
      // One unreachable repository should not stop the rest of the sync.
      // The next inventory pass restores access if it comes back.
      if (
        error instanceof SafeError &&
        (error.code === "GITHUB_NOT_FOUND" || error.code === "GITHUB_ACCESS_DENIED")
      ) {
        await db.query(
          `UPDATE repositories SET accessible = false, updated_at = now() WHERE id = $1`,
          [repoId],
        );
        continue;
      }
      throw error;
    }
  }
}

export async function syncWorkspace(deps: ServiceDeps): Promise<void> {
  await syncInventory(deps);
  await syncPullRequests(deps);
}

export async function upsertPullRequest(
  db: Db,
  workspaceId: string,
  repoId: number,
  pr: PullRequestInfo,
): Promise<string> {
  const id = pullRequestId(repoId, pr.number);
  await db.query(
    `INSERT INTO pull_requests
       (id, repo_id, workspace_id, number, title, author, url, state, draft, head_sha, base_sha, opened_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title,
       author = EXCLUDED.author,
       url = EXCLUDED.url,
       state = EXCLUDED.state,
       draft = EXCLUDED.draft,
       head_sha = EXCLUDED.head_sha,
       base_sha = EXCLUDED.base_sha,
       updated_at = now()`,
    [
      id,
      repoId,
      workspaceId,
      pr.number,
      pr.title,
      pr.author,
      pr.url,
      pr.state,
      pr.draft,
      pr.headSha,
      pr.baseSha,
      pr.openedAt,
    ],
  );
  return id;
}

/**
 * Creates a run and job for the PR's current commit pair. Draft PRs are included.
 * Returns the run ID, or null when there is nothing new to review.
 */
export async function scheduleReview(deps: ServiceDeps, prId: string): Promise<string | null> {
  const { config, db } = deps;
  const rows = await db.query(
    `SELECT p.head_sha, p.base_sha, p.state, r.enabled, r.accessible, r.archived, i.active
     FROM pull_requests p
     JOIN repositories r ON r.id = p.repo_id
     JOIN installations i ON i.id = r.installation_id
     WHERE p.id = $1`,
    [prId],
  );
  const pr = rows[0];
  if (!pr || pr.state !== "open") return null;
  if (!pr.enabled || !pr.accessible || pr.archived || !pr.active) return null;

  return db.transaction(async (tx) => {
    const runId = randomUUID();
    const inserted = await tx.query(
      `INSERT INTO review_runs (id, pr_id, workspace_id, head_sha, base_sha, model, prompt_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (pr_id, head_sha, base_sha, prompt_version) DO NOTHING
       RETURNING id`,
      [runId, prId, config.targetAccount, pr.head_sha, pr.base_sha, config.reviewModel, PROMPT_VERSION],
    );
    if (inserted.length === 0) return null;
    await enqueueJob(tx, {
      workspaceId: config.targetAccount,
      dedupKey: `review:${runId}`,
      kind: "review",
      payload: { runId },
    });
    return runId;
  });
}

/** Queues a one-off sync. Periodic syncs use a time-bucketed key instead. */
export async function enqueueSync(deps: Pick<ServiceDeps, "config" | "db">): Promise<void> {
  await enqueueJob(deps.db, {
    workspaceId: deps.config.targetAccount,
    dedupKey: `sync:once:${randomUUID()}`,
    kind: "sync",
    payload: {},
  });
}

export async function enqueuePeriodicSync(
  deps: Pick<ServiceDeps, "config" | "db">,
  now = Date.now(),
): Promise<void> {
  await enqueueJob(deps.db, {
    workspaceId: deps.config.targetAccount,
    dedupKey: `sync:${Math.floor(now / SYNC_INTERVAL_MS)}`,
    kind: "sync",
    payload: {},
  });
}

async function findRepository(deps: ServiceDeps, repoId: number): Promise<Row | undefined> {
  const rows = await deps.db.query(
    `SELECT id, installation_id, full_name FROM repositories WHERE id = $1 AND workspace_id = $2`,
    [repoId, deps.config.targetAccount],
  );
  return rows[0];
}

export async function processWebhook(deps: ServiceDeps, webhook: NormalizedWebhook): Promise<void> {
  switch (webhook.event) {
    case "pull_request":
      return handlePullRequest(deps, webhook);
    case "pull_request_review_thread":
      return handleReviewThread(deps, webhook);
    case "repository":
      return handleRepository(deps, webhook);
    case "installation":
      return handleInstallation(deps, webhook);
    case "installation_repositories":
      return enqueueSync(deps);
    default:
      return;
  }
}

async function handlePullRequest(deps: ServiceDeps, webhook: NormalizedWebhook): Promise<void> {
  if (!webhook.repository || webhook.prNumber === null) return;
  assertRepositoryOwner(deps.config, webhook.repository.fullName);

  let repository = await findRepository(deps, webhook.repository.id);
  if (!repository) {
    await syncInventory(deps);
    repository = await findRepository(deps, webhook.repository.id);
    if (!repository) return;
  }

  // The API is authoritative. The delivery may be older than the current head.
  const current = await requireGitHub(deps).getPullRequest(
    repoRef(repository as any),
    webhook.prNumber,
  );
  if (!current) return;

  const repoId = Number(repository.id);
  const prId = await upsertPullRequest(deps.db, deps.config.targetAccount, repoId, current);
  if (webhook.action && REVIEW_ACTIONS.has(webhook.action)) {
    await scheduleReview(deps, prId);
  }
}

async function handleReviewThread(deps: ServiceDeps, webhook: NormalizedWebhook): Promise<void> {
  if (webhook.action !== "resolved" && webhook.action !== "unresolved") return;
  // Resolving a discussion says nothing about the code, so outcome is left alone.
  await deps.db.query(
    `UPDATE findings SET thread_resolved = $1
     WHERE workspace_id = $2 AND github_comment_id = ANY($3::bigint[])`,
    [webhook.action === "resolved", deps.config.targetAccount, webhook.threadCommentIds],
  );
}

async function handleRepository(deps: ServiceDeps, webhook: NormalizedWebhook): Promise<void> {
  const repository = webhook.repository;
  if (!repository) return;

  if (webhook.action === "deleted" || webhook.action === "transferred") {
    await deps.db.query(
      `UPDATE repositories SET accessible = false, updated_at = now()
       WHERE id = $1 AND workspace_id = $2`,
      [repository.id, deps.config.targetAccount],
    );
    return;
  }

  await deps.db.query(
    `UPDATE repositories SET full_name = $1, private = $2, archived = $3, updated_at = now()
     WHERE id = $4 AND workspace_id = $5`,
    [
      repository.fullName,
      repository.private,
      repository.archived,
      repository.id,
      deps.config.targetAccount,
    ],
  );
}

async function handleInstallation(deps: ServiceDeps, webhook: NormalizedWebhook): Promise<void> {
  if (webhook.action === "deleted" || webhook.action === "suspend") {
    if (webhook.installationId === null) return;
    await deps.db.query(
      `UPDATE installations SET active = false, updated_at = now()
       WHERE id = $1 AND workspace_id = $2`,
      [webhook.installationId, deps.config.targetAccount],
    );
    return;
  }
  await enqueueSync(deps);
}
