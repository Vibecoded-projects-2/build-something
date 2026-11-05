import { budgetMonth } from "./budget.ts";
import type { AppConfig } from "./config.ts";
import type { Queryable, Row } from "./db.ts";

export const DASHBOARD_WINDOWS = [7, 30, 90] as const;
export type DashboardWindow = (typeof DASHBOARD_WINDOWS)[number];

const LIST_LIMIT = 200;

const PUBLISHED_FINDING_COLUMNS = `
  f.id, f.pr_id, f.run_id, f.category, f.severity, f.title, f.body, f.path, f.line,
  f.evidence, f.suggestion, f.outcome, f.assessment, f.fix_sha, f.fixed_at,
  f.thread_resolved, f.github_comment_url, f.helpful, f.created_at`;

function mapFinding(row: Row) {
  return {
    id: row.id,
    prId: row.pr_id,
    runId: row.run_id,
    category: row.category,
    severity: row.severity,
    title: row.title,
    body: row.body,
    path: row.path,
    line: row.line,
    evidence: row.evidence,
    suggestion: row.suggestion,
    outcome: row.outcome,
    assessment: row.assessment,
    fixSha: row.fix_sha,
    fixedAt: row.fixed_at,
    threadResolved: row.thread_resolved,
    commentUrl: row.github_comment_url,
    helpful: row.helpful,
    createdAt: row.created_at,
    repository: row.full_name,
    prNumber: row.number,
  };
}

function mapRun(row: Row) {
  return {
    id: row.id,
    prId: row.pr_id,
    headSha: row.head_sha,
    baseSha: row.base_sha,
    model: row.model,
    promptVersion: row.prompt_version,
    state: row.state,
    coverage: row.coverage,
    summary: row.summary,
    errorCode: row.error_code,
    costUsd: Number(row.cost_usd),
    usage: row.usage,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    repository: row.full_name,
    prNumber: row.number,
    prTitle: row.title,
    jobState: row.job_state ?? null,
  };
}

async function metrics(db: Queryable, workspaceId: string, days: number) {
  const params = [workspaceId, days];

  const [monitored] = await db.query(
    `SELECT count(*)::int AS count
     FROM repositories r JOIN installations i ON i.id = r.installation_id
     WHERE r.workspace_id = $1 AND r.enabled AND r.accessible AND NOT r.archived AND i.active`,
    [workspaceId],
  );

  // Pull request coverage uses the PR opened window.
  const [pulls] = await db.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM review_runs r
              WHERE r.pr_id = p.id AND r.state IN ('completed', 'partial')
            ))::int AS reviewed
     FROM pull_requests p
     WHERE p.workspace_id = $1 AND p.opened_at >= now() - make_interval(days => $2)`,
    params,
  );

  // Run figures use the run creation window. Latency includes queue time.
  const [runs] = await db.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE state IN ('completed', 'partial'))::int AS succeeded,
            count(*) FILTER (WHERE state = 'failed')::int AS failed,
            COALESCE(sum(cost_usd), 0) AS cost,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - created_at))
              FILTER (WHERE state IN ('completed', 'partial')) AS latency_median,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - created_at))
              FILTER (WHERE state IN ('completed', 'partial')) AS latency_p95
     FROM review_runs
     WHERE workspace_id = $1 AND created_at >= now() - make_interval(days => $2)`,
    params,
  );

  // Finding figures use the finding creation window and published findings only.
  const [findings] = await db.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE outcome = 'confirmed_fixed')::int AS confirmed,
            count(*) FILTER (WHERE outcome = 'suspected_fixed')::int AS suspected,
            count(*) FILTER (WHERE helpful IS TRUE)::int AS helpful,
            count(*) FILTER (WHERE helpful IS FALSE)::int AS unhelpful
     FROM findings
     WHERE workspace_id = $1 AND github_comment_id IS NOT NULL
       AND created_at >= now() - make_interval(days => $2)`,
    params,
  );

  const attempted = Number(runs?.succeeded) + Number(runs?.failed);
  return {
    monitoredRepositories: monitored?.count ?? 0,
    totalPrs: pulls?.total ?? 0,
    reviewedPrs: pulls?.reviewed ?? 0,
    prCoverage: pulls?.total ? pulls.reviewed / pulls.total : null,
    reviewRuns: runs?.total ?? 0,
    findings: findings?.total ?? 0,
    confirmedFixes: findings?.confirmed ?? 0,
    suspectedFixes: findings?.suspected ?? 0,
    helpful: findings?.helpful ?? 0,
    unhelpful: findings?.unhelpful ?? 0,
    latencyMedianSeconds: runs?.latency_median === null ? null : Number(runs?.latency_median),
    latencyP95Seconds: runs?.latency_p95 === null ? null : Number(runs?.latency_p95),
    estimatedCostUsd: Number(runs?.cost ?? 0),
    successRate: attempted > 0 ? Number(runs?.succeeded) / attempted : null,
  };
}

export async function dashboard(
  db: Queryable,
  config: AppConfig,
  days: DashboardWindow,
  hasGitHubClient: boolean,
) {
  const workspaceId = config.targetAccount;
  const params = [workspaceId, days];

  const repositories = await db.query(
    `SELECT r.id, r.full_name, r.private, r.archived, r.enabled, r.accessible,
            i.active AS installation_active,
            count(DISTINCT p.id) FILTER (WHERE run.state IN ('completed', 'partial'))::int AS review_count,
            max(run.finished_at) FILTER (WHERE run.state IN ('completed', 'partial')) AS last_review_at
     FROM repositories r
     JOIN installations i ON i.id = r.installation_id
     LEFT JOIN pull_requests p ON p.repo_id = r.id
     LEFT JOIN review_runs run ON run.pr_id = p.id
     WHERE r.workspace_id = $1
     GROUP BY r.id, i.active
     ORDER BY r.full_name`,
    [workspaceId],
  );

  const pullRequests = await db.query(
    `SELECT p.id, p.number, p.title, p.author, p.url, p.state, p.draft, p.head_sha, p.opened_at,
            r.full_name,
            latest.state AS run_state,
            latest.finished_at AS last_reviewed_at,
            (SELECT count(*)::int FROM review_runs run WHERE run.pr_id = p.id) AS run_count,
            (SELECT count(*)::int FROM findings f
             WHERE f.pr_id = p.id AND f.github_comment_id IS NOT NULL) AS finding_count
     FROM pull_requests p
     JOIN repositories r ON r.id = p.repo_id
     LEFT JOIN LATERAL (
       SELECT state, finished_at FROM review_runs run
       WHERE run.pr_id = p.id ORDER BY created_at DESC LIMIT 1
     ) latest ON true
     WHERE p.workspace_id = $1 AND p.opened_at >= now() - make_interval(days => $2)
     ORDER BY p.opened_at DESC
     LIMIT ${LIST_LIMIT}`,
    params,
  );

  const findings = await db.query(
    `SELECT ${PUBLISHED_FINDING_COLUMNS}, r.full_name, p.number
     FROM findings f
     JOIN pull_requests p ON p.id = f.pr_id
     JOIN repositories r ON r.id = p.repo_id
     WHERE f.workspace_id = $1 AND f.github_comment_id IS NOT NULL
       AND f.created_at >= now() - make_interval(days => $2)
     ORDER BY f.created_at DESC
     LIMIT ${LIST_LIMIT}`,
    params,
  );

  const runs = await db.query(
    `SELECT run.*, p.number, p.title, r.full_name, j.state AS job_state
     FROM review_runs run
     JOIN pull_requests p ON p.id = run.pr_id
     JOIN repositories r ON r.id = p.repo_id
     LEFT JOIN jobs j ON j.dedup_key = 'review:' || run.id
     WHERE run.workspace_id = $1 AND run.created_at >= now() - make_interval(days => $2)
     ORDER BY run.created_at DESC
     LIMIT ${LIST_LIMIT}`,
    params,
  );

  const trend = await db.query(
    `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
            count(*)::int AS runs,
            count(*) FILTER (WHERE state IN ('completed', 'partial'))::int AS reviewed
     FROM review_runs
     WHERE workspace_id = $1 AND created_at >= now() - make_interval(days => $2)
     GROUP BY day ORDER BY day`,
    params,
  );

  const categories = await db.query(
    `SELECT category, count(*)::int AS count
     FROM findings
     WHERE workspace_id = $1 AND github_comment_id IS NOT NULL
       AND created_at >= now() - make_interval(days => $2)
     GROUP BY category ORDER BY count DESC, category`,
    params,
  );

  const [jobs] = await db.query(
    `SELECT count(*) FILTER (WHERE state = 'pending')::int AS pending,
            count(*) FILTER (WHERE state = 'running')::int AS running,
            count(*) FILTER (WHERE state = 'dead')::int AS dead
     FROM jobs WHERE workspace_id = $1`,
    [workspaceId],
  );

  const month = budgetMonth();
  const [budget] = await db.query(
    `SELECT spent_usd, reserved_usd FROM budget_months WHERE workspace_id = $1 AND month = $2`,
    [workspaceId, month],
  );

  const [installation] = await db.query(
    `SELECT repository_selection FROM installations
     WHERE workspace_id = $1 AND active ORDER BY updated_at DESC LIMIT 1`,
    [workspaceId],
  );

  const appSlug = config.github.appSlug ?? null;

  return {
    ok: true as const,
    workspace: { account: workspaceId, model: config.reviewModel },
    days,
    metrics: await metrics(db, workspaceId, days),
    trend,
    categories,
    repositories: repositories.map((row) => ({
      id: Number(row.id),
      fullName: row.full_name,
      private: row.private,
      archived: row.archived,
      enabled: row.enabled,
      accessible: row.accessible,
      installationActive: row.installation_active,
      reviewCount: row.review_count,
      lastReviewAt: row.last_review_at,
    })),
    pullRequests: pullRequests.map((row) => ({
      id: row.id,
      number: row.number,
      title: row.title,
      author: row.author,
      url: row.url,
      state: row.state,
      draft: row.draft,
      headSha: row.head_sha,
      openedAt: row.opened_at,
      repository: row.full_name,
      runState: row.run_state,
      lastReviewedAt: row.last_reviewed_at,
      runCount: row.run_count,
      findingCount: row.finding_count,
    })),
    findings: findings.map(mapFinding),
    runs: runs.map(mapRun),
    jobs: { pending: jobs?.pending ?? 0, running: jobs?.running ?? 0, dead: jobs?.dead ?? 0 },
    budget: {
      month,
      limitUsd: config.monthlyBudgetUsd,
      spentUsd: Number(budget?.spent_usd ?? 0),
      reservedUsd: Number(budget?.reserved_usd ?? 0),
    },
    // These report configuration presence. They are not live connectivity probes.
    integrations: {
      githubApp: hasGitHubClient,
      webhookSecret: Boolean(config.github.webhookSecret),
      anthropicKey: Boolean(config.anthropic.apiKey),
      sqs: Boolean(config.sqsQueueUrl),
    },
    settings: {
      webhookUrl: `${config.appOrigin}/webhooks/github`,
      installUrl: appSlug ? `https://github.com/apps/${appSlug}/installations/new` : null,
      repositorySelection: installation?.repository_selection ?? null,
      maxPrFiles: config.maxPrFiles,
      maxContextBytes: config.maxContextBytes,
      maxInputTokens: config.maxReviewInputTokens,
      maxOutputTokens: config.maxReviewOutputTokens,
    },
  };
}

export async function pullRequestDetail(db: Queryable, workspaceId: string, prId: string) {
  const [pr] = await db.query(
    `SELECT p.id, p.number, p.title, p.author, p.url, p.state, p.draft, p.head_sha, p.base_sha,
            p.opened_at, r.full_name
     FROM pull_requests p JOIN repositories r ON r.id = p.repo_id
     WHERE p.id = $1 AND p.workspace_id = $2`,
    [prId, workspaceId],
  );
  if (!pr) return null;

  const runs = await db.query(
    `SELECT run.*, p.number, p.title, r.full_name, j.state AS job_state
     FROM review_runs run
     JOIN pull_requests p ON p.id = run.pr_id
     JOIN repositories r ON r.id = p.repo_id
     LEFT JOIN jobs j ON j.dedup_key = 'review:' || run.id
     WHERE run.pr_id = $1 ORDER BY run.created_at DESC`,
    [prId],
  );
  const findings = await db.query(
    `SELECT ${PUBLISHED_FINDING_COLUMNS}, r.full_name, p.number
     FROM findings f
     JOIN pull_requests p ON p.id = f.pr_id
     JOIN repositories r ON r.id = p.repo_id
     WHERE f.pr_id = $1 AND f.github_comment_id IS NOT NULL
     ORDER BY f.created_at DESC`,
    [prId],
  );

  return {
    ok: true as const,
    pullRequest: {
      id: pr.id,
      number: pr.number,
      title: pr.title,
      author: pr.author,
      url: pr.url,
      state: pr.state,
      draft: pr.draft,
      headSha: pr.head_sha,
      baseSha: pr.base_sha,
      openedAt: pr.opened_at,
      repository: pr.full_name,
    },
    runs: runs.map(mapRun),
    findings: findings.map(mapFinding),
  };
}
