import { randomUUID } from "node:crypto";
import { chargeUsage, releaseAbandonedReservations, releaseReservation, reserveBudget } from "./budget.ts";
import { buildContext, sanitizeModelText, type Coverage } from "./context.ts";
import type { Db, Row } from "./db.ts";
import {
  findingFingerprint,
  findingMarker,
  runMarker,
  safeErrorCode,
  SafeError,
  type FindingCandidate,
  type RunState,
  type VerificationResult,
} from "./domain.ts";
import type { GitHubGateway, PullRequestInfo, RepoRef } from "./github.ts";
import { assertLease, MAX_ATTEMPTS, type Job, type JobKind } from "./jobs.ts";
import {
  MAX_PREVIOUS_FINDINGS,
  reservationUsd,
  type PreviousFinding,
  type ReviewModel,
  type UsageSink,
} from "./reviewer.ts";
import {
  processWebhook,
  repoRef,
  scheduleReview,
  syncWorkspace,
  upsertPullRequest,
  type ServiceDeps,
} from "./service.ts";
import type { JobHandler } from "./worker.ts";

export interface EngineDeps extends ServiceDeps {
  model: ReviewModel | null;
  /** Configured secret values that must never reach a model or a comment. */
  knownSecrets?: readonly string[];
}

const TERMINAL_STATES: ReadonlySet<string> = new Set(["completed", "partial", "superseded", "skipped"]);

async function loadRun(db: Db, runId: string): Promise<Row | undefined> {
  const rows = await db.query(
    `SELECT run.id, run.pr_id, run.workspace_id, run.head_sha, run.base_sha, run.model, run.state,
            run.summary, run.coverage,
            pr.number, pr.title, pr.repo_id,
            repo.full_name, repo.installation_id, repo.enabled, repo.accessible, repo.archived,
            installation.active
     FROM review_runs run
     JOIN pull_requests pr ON pr.id = run.pr_id
     JOIN repositories repo ON repo.id = pr.repo_id
     JOIN installations installation ON installation.id = repo.installation_id
     WHERE run.id = $1`,
    [runId],
  );
  return rows[0];
}

function policyAllowsReview(run: Row): boolean {
  return Boolean(run.enabled && run.accessible && !run.archived && run.active);
}

async function finishRun(
  db: Db,
  runId: string,
  state: RunState,
  summary?: string,
): Promise<void> {
  await db.query(
    `UPDATE review_runs
     SET state = $2, finished_at = now(), error_code = NULL, summary = COALESCE($3, summary)
     WHERE id = $1`,
    [runId, state, summary ?? null],
  );
  await releaseReservation(db, runId);
}

/** Keeps candidates anchored to an added line and not already reported on this PR. */
export function filterCandidates(
  candidates: FindingCandidate[],
  anchors: ReadonlyMap<string, ReadonlySet<number>>,
  knownFingerprints: ReadonlySet<string>,
): FindingCandidate[] {
  const seen = new Set(knownFingerprints);
  return candidates.filter((candidate) => {
    if (!anchors.get(candidate.path)?.has(candidate.line)) return false;
    const fingerprint = findingFingerprint(candidate);
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
}

async function previousFindings(db: Db, prId: string): Promise<PreviousFinding[]> {
  const rows = await db.query(
    `SELECT id, title, body, path, line, outcome FROM findings
     WHERE pr_id = $1 AND github_comment_id IS NOT NULL
       AND outcome IN ('open', 'suspected_fixed', 'unverifiable')
     ORDER BY created_at DESC
     LIMIT $2`,
    [prId, MAX_PREVIOUS_FINDINGS],
  );
  return rows as PreviousFinding[];
}

/** Applies model assessments. Human decisions are never overwritten. */
async function applyAssessments(
  deps: EngineDeps,
  previous: PreviousFinding[],
  assessments: VerificationResult["previousFindings"],
): Promise<void> {
  const known = new Set(previous.map((finding) => finding.id));
  for (const assessment of assessments) {
    if (!known.has(assessment.id)) continue;
    await deps.db.query(
      `UPDATE findings SET outcome = $2, assessment = $3
       WHERE id = $1 AND outcome NOT IN ('confirmed_fixed', 'dismissed')`,
      [assessment.id, assessment.outcome, sanitizeModelText(assessment.evidence, deps.knownSecrets)],
    );
  }
}

async function saveFindings(
  deps: EngineDeps,
  run: Row,
  accepted: FindingCandidate[],
  summary: string,
): Promise<void> {
  const clean = (text: string) => sanitizeModelText(text, deps.knownSecrets);
  await deps.db.transaction(async (tx) => {
    for (const finding of accepted) {
      await tx.query(
        `INSERT INTO findings
           (id, workspace_id, pr_id, run_id, fingerprint, category, severity,
            title, body, path, line, evidence, suggestion)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (pr_id, fingerprint) DO NOTHING`,
        [
          randomUUID(),
          run.workspace_id,
          run.pr_id,
          run.id,
          findingFingerprint(finding),
          finding.category,
          finding.severity,
          clean(finding.title),
          clean(finding.body),
          finding.path,
          finding.line,
          clean(finding.evidence),
          clean(finding.suggestion),
        ],
      );
    }
    await tx.query(`UPDATE review_runs SET state = 'publishing', summary = $2 WHERE id = $1`, [
      run.id,
      clean(summary),
    ]);
  });
}

function reviewBody(run: Row, summary: string, coverage: Coverage | null): string {
  const parts = ["## Reviewgate", summary || "No actionable findings."];
  if (coverage && !coverage.complete) {
    parts.push("_Partial coverage: some changed files could not be fully reviewed._");
  }
  parts.push(runMarker(run.id));
  return parts.join("\n\n");
}

function commentBody(finding: Row): string {
  return [
    `**${finding.severity} · ${finding.category}: ${finding.title}**`,
    finding.body,
    `**Evidence:** ${finding.evidence}`,
    `**Suggested fix:** ${finding.suggestion}`,
    findingMarker(finding.id),
  ].join("\n\n");
}

/** Copies GitHub IDs onto findings using the marker in each comment. */
async function reconcileComments(
  deps: EngineDeps,
  github: GitHubGateway,
  ref: RepoRef,
  run: Row,
  reviewId: number,
): Promise<boolean> {
  const { db } = deps;
  const comments = await github.listReviewComments(ref, run.number, reviewId);
  const findings = await db.query(`SELECT id FROM findings WHERE run_id = $1`, [run.id]);
  let matched = 0;

  for (const finding of findings) {
    const marker = findingMarker(finding.id);
    const comment = comments.find((item) => item.body.includes(marker));
    if (!comment) continue;
    matched += 1;
    await db.query(`UPDATE findings SET github_comment_id = $2, github_comment_url = $3 WHERE id = $1`, [
      finding.id,
      comment.id,
      comment.url,
    ]);
  }

  await db.query(`UPDATE review_runs SET github_review_id = $2 WHERE id = $1`, [run.id, reviewId]);
  return matched === findings.length;
}

async function finishPublished(
  deps: EngineDeps,
  github: GitHubGateway,
  ref: RepoRef,
  run: Row,
  reviewId: number,
): Promise<void> {
  const allMatched = await reconcileComments(deps, github, ref, run, reviewId);
  const [{ coverage }] = (await deps.db.query(`SELECT coverage FROM review_runs WHERE id = $1`, [
    run.id,
  ])) as [Row];
  const complete = allMatched && Boolean((coverage as Coverage | null)?.complete);
  await finishRun(deps.db, run.id, complete ? "completed" : "partial");
}

/** True when GitHub already holds this run's review, for example after a lost response. */
async function recoverPublication(
  deps: EngineDeps,
  github: GitHubGateway,
  ref: RepoRef,
  run: Row,
): Promise<boolean> {
  const marker = runMarker(run.id);
  const existing = (await github.listReviews(ref, run.number)).find((review) =>
    review.body.includes(marker),
  );
  if (!existing) return false;
  await finishPublished(deps, github, ref, run, existing.id);
  return true;
}

/** Marks the run superseded and queues the current commit pair if the PR moved on. */
async function supersedeIfStale(
  deps: EngineDeps,
  run: Row,
  current: PullRequestInfo,
): Promise<boolean> {
  if (current.headSha === run.head_sha && current.baseSha === run.base_sha) return false;
  const { db, config } = deps;
  await discardUnpublished(db, run.id);
  await finishRun(db, run.id, "superseded");
  const prId = await upsertPullRequest(db, config.targetAccount, Number(run.repo_id), current);
  await scheduleReview(deps, prId);
  return true;
}

async function discardUnpublished(db: Db, runId: string): Promise<void> {
  await db.query(`DELETE FROM findings WHERE run_id = $1 AND github_comment_id IS NULL`, [runId]);
}

async function generateAndVerify(
  deps: EngineDeps,
  model: ReviewModel,
  github: GitHubGateway,
  ref: RepoRef,
  run: Row,
): Promise<void> {
  const { config, db } = deps;
  await reserveBudget(db, {
    workspaceId: run.workspace_id,
    runId: run.id,
    amountUsd: reservationUsd(run.model, config.maxReviewInputTokens, config.maxReviewOutputTokens),
    limitUsd: config.monthlyBudgetUsd,
  });
  await db.query(
    `UPDATE review_runs
     SET state = 'reviewing', error_code = NULL, started_at = COALESCE(started_at, now())
     WHERE id = $1`,
    [run.id],
  );

  const previous = await previousFindings(db, run.pr_id);
  const context = await buildContext({
    github,
    ref,
    number: run.number,
    title: run.title,
    headSha: run.head_sha,
    baseSha: run.base_sha,
    maxFiles: config.maxPrFiles,
    maxBytes: config.maxContextBytes,
    knownSecrets: deps.knownSecrets,
    priorPaths: previous.map((finding) => finding.path),
  });
  await db.query(`UPDATE review_runs SET coverage = $2 WHERE id = $1`, [
    run.id,
    JSON.stringify(context.coverage),
  ]);

  if (context.anchors.size === 0 && previous.length === 0) {
    await finishRun(db, run.id, "partial", "No reviewable source in this pull request.");
    return;
  }

  const onUsage: UsageSink = (usage) => chargeUsage(db, run.id, usage);
  const generation =
    context.anchors.size > 0
      ? await model.generate(context.serialized, onUsage)
      : { summary: "", findings: [] };

  const fingerprints = await db.query(`SELECT fingerprint FROM findings WHERE pr_id = $1`, [run.pr_id]);
  const candidates = filterCandidates(
    generation.findings,
    context.anchors,
    new Set(fingerprints.map((row) => row.fingerprint)),
  );

  let accepted: FindingCandidate[] = [];
  let summary = generation.summary;
  if (candidates.length > 0 || previous.length > 0) {
    const verification = await model.verify(context.serialized, candidates, previous, onUsage);
    accepted = [...new Set(verification.acceptedIndices)].flatMap((index) => {
      const candidate = candidates[index];
      return candidate ? [candidate] : [];
    });
    summary = verification.summary || summary;
    await applyAssessments(deps, previous, verification.previousFindings);
  }

  await saveFindings(deps, run, accepted, summary);
}

async function publish(
  deps: EngineDeps,
  github: GitHubGateway,
  ref: RepoRef,
  job: Job,
  runId: string,
): Promise<void> {
  const { db } = deps;

  // Commit and policy can both change during a model call of several minutes.
  const run = await loadRun(db, runId);
  if (!run) return;
  const current = await github.getPullRequest(ref, run.number);
  if (!current || current.state !== "open" || !policyAllowsReview(run)) {
    await discardUnpublished(db, run.id);
    await finishRun(db, run.id, "skipped");
    return;
  }
  if (await supersedeIfStale(deps, run, current)) return;

  await assertLease(db, job);

  const findings = await db.query(
    `SELECT * FROM findings WHERE run_id = $1 AND github_comment_id IS NULL ORDER BY created_at`,
    [run.id],
  );
  const review = await github.createReview(ref, run.number, {
    commitSha: run.head_sha,
    body: reviewBody(run, run.summary ?? "", run.coverage),
    comments: findings.map((finding) => ({
      path: finding.path,
      line: finding.line,
      body: commentBody(finding),
    })),
  });
  await finishPublished(deps, github, ref, run, review.id);
}

async function reviewRun(deps: EngineDeps, job: Job, runId: string): Promise<void> {
  const { db } = deps;
  const run = await loadRun(db, runId);
  if (!run || TERMINAL_STATES.has(run.state)) return;

  if (!policyAllowsReview(run)) {
    await finishRun(db, run.id, "skipped");
    return;
  }
  if (!deps.github) throw new SafeError("GITHUB_APP_NOT_CONFIGURED");
  if (!deps.model) throw new SafeError("ANTHROPIC_KEY_NOT_CONFIGURED");

  const github = deps.github;
  const ref = repoRef(run as any);
  const current = await github.getPullRequest(ref, run.number);
  if (!current || current.state !== "open") {
    await finishRun(db, run.id, "skipped");
    return;
  }
  if (await supersedeIfStale(deps, run, current)) return;
  if (await recoverPublication(deps, github, ref, run)) return;

  // A run left in `publishing` already has saved output, so it costs no model calls.
  if (run.state !== "publishing") {
    await generateAndVerify(deps, deps.model, github, ref, run);
    const [{ state }] = (await db.query(`SELECT state FROM review_runs WHERE id = $1`, [run.id])) as [Row];
    if (state !== "publishing") return;
  }
  await publish(deps, github, ref, job, run.id);
}

async function recordFailure(deps: EngineDeps, job: Job, runId: string, error: unknown): Promise<void> {
  const code = safeErrorCode(error);
  // Another worker owns the run now, so this one must leave it alone.
  if (code === "JOB_LEASE_LOST") return;

  await deps.db.query(
    `UPDATE review_runs
     SET error_code = $2,
         state = CASE WHEN state = 'publishing' THEN 'publishing' ELSE 'failed' END
     WHERE id = $1`,
    [runId, code],
  );
  const retryable = error instanceof SafeError ? error.retryable : true;
  if (!retryable || job.attempts >= MAX_ATTEMPTS) await releaseReservation(deps.db, runId);
}

export async function runReview(deps: EngineDeps, job: Job): Promise<void> {
  const runId: string = job.payload.runId;
  try {
    await reviewRun(deps, job, runId);
  } catch (error) {
    await recordFailure(deps, job, runId, error);
    throw error;
  }
}

export function createHandlers(deps: EngineDeps): Record<JobKind, JobHandler> {
  return {
    webhook: (job) => processWebhook(deps, job.payload),
    sync: async () => {
      await releaseAbandonedReservations(deps.db, deps.config.targetAccount);
      await syncWorkspace(deps);
    },
    review: (job) => runReview(deps, job),
  };
}
