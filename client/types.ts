export type DashboardWindow = 7 | 30 | 90;

export type RunState =
  | "queued"
  | "reviewing"
  | "publishing"
  | "completed"
  | "partial"
  | "failed"
  | "superseded"
  | "skipped";

export type FindingOutcome = "open" | "suspected_fixed" | "unverifiable" | "confirmed_fixed" | "dismissed";

export interface Metrics {
  monitoredRepositories: number;
  totalPrs: number;
  reviewedPrs: number;
  prCoverage: number | null;
  reviewRuns: number;
  findings: number;
  confirmedFixes: number;
  suspectedFixes: number;
  helpful: number;
  unhelpful: number;
  latencyMedianSeconds: number | null;
  latencyP95Seconds: number | null;
  estimatedCostUsd: number;
  successRate: number | null;
}

export interface Repository {
  id: number;
  fullName: string;
  private: boolean;
  archived: boolean;
  enabled: boolean;
  accessible: boolean;
  installationActive: boolean;
  reviewCount: number;
  lastReviewAt: string | null;
}

export interface PullRequest {
  id: string;
  number: number;
  title: string;
  author: string;
  url: string;
  state: string;
  draft: boolean;
  headSha: string;
  openedAt: string;
  repository: string;
  runState: RunState | null;
  lastReviewedAt: string | null;
  runCount: number;
  findingCount: number;
}

export interface Finding {
  id: string;
  prId: string;
  runId: string;
  category: string;
  severity: string;
  title: string;
  body: string;
  path: string;
  line: number;
  evidence: string;
  suggestion: string;
  outcome: FindingOutcome;
  assessment: string | null;
  fixSha: string | null;
  fixedAt: string | null;
  threadResolved: boolean;
  commentUrl: string | null;
  helpful: boolean | null;
  createdAt: string;
  repository: string;
  prNumber: number;
}

export interface Coverage {
  filesChanged: number;
  filesReviewed: number;
  relatedFiles: number;
  excluded: string[];
  missingSource: string[];
  omittedDiffs: string[];
  contextLimited: string[];
  fileLimitReached: boolean;
  complete: boolean;
}

export interface ReviewRun {
  id: string;
  prId: string;
  headSha: string;
  baseSha: string;
  model: string;
  promptVersion: string;
  state: RunState;
  coverage: Coverage | null;
  summary: string | null;
  errorCode: string | null;
  costUsd: number;
  usage: { inputTokens: number; outputTokens: number } | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  repository: string;
  prNumber: number;
  prTitle: string;
  jobState: string | null;
}

export interface Dashboard {
  ok: true;
  workspace: { account: string; model: string };
  days: DashboardWindow;
  metrics: Metrics;
  trend: Array<{ day: string; runs: number; reviewed: number }>;
  categories: Array<{ category: string; count: number }>;
  repositories: Repository[];
  pullRequests: PullRequest[];
  findings: Finding[];
  runs: ReviewRun[];
  jobs: { pending: number; running: number; dead: number };
  budget: { month: string; limitUsd: number; spentUsd: number; reservedUsd: number };
  integrations: { githubApp: boolean; webhookSecret: boolean; anthropicKey: boolean; sqs: boolean };
  settings: {
    webhookUrl: string;
    installUrl: string | null;
    repositorySelection: string | null;
    maxPrFiles: number;
    maxContextBytes: number;
    maxInputTokens: number;
    maxOutputTokens: number;
  };
}

export interface PullRequestDetail {
  ok: true;
  pullRequest: {
    id: string;
    number: number;
    title: string;
    author: string;
    url: string;
    state: string;
    draft: boolean;
    headSha: string;
    baseSha: string;
    openedAt: string;
    repository: string;
  };
  runs: ReviewRun[];
  findings: Finding[];
}

export interface Session {
  authenticated: boolean;
  username?: string;
  csrfToken?: string;
}
