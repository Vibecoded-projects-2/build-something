/** The schema is idempotent so every startup can apply it under the advisory lock. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workspaces (
  id text PRIMARY KEY,
  account_login text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  username text NOT NULL,
  csrf_token text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS installations (
  id bigint PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  account_id bigint NOT NULL,
  account_login text NOT NULL,
  repository_selection text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS repositories (
  id bigint PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  installation_id bigint NOT NULL REFERENCES installations(id),
  full_name text NOT NULL,
  private boolean NOT NULL DEFAULT false,
  archived boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  accessible boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pull_requests (
  id text PRIMARY KEY,
  repo_id bigint NOT NULL REFERENCES repositories(id),
  workspace_id text NOT NULL REFERENCES workspaces(id),
  number integer NOT NULL,
  title text NOT NULL,
  author text NOT NULL,
  url text NOT NULL,
  state text NOT NULL,
  draft boolean NOT NULL DEFAULT false,
  head_sha text NOT NULL,
  base_sha text NOT NULL,
  opened_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repo_id, number)
);

CREATE TABLE IF NOT EXISTS review_runs (
  id text PRIMARY KEY,
  pr_id text NOT NULL REFERENCES pull_requests(id),
  workspace_id text NOT NULL REFERENCES workspaces(id),
  head_sha text NOT NULL,
  base_sha text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  state text NOT NULL DEFAULT 'queued',
  coverage jsonb,
  summary text,
  error_code text,
  github_review_id bigint,
  cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
  reserved_usd numeric(12, 6) NOT NULL DEFAULT 0,
  budget_month text,
  usage jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (pr_id, head_sha, base_sha, prompt_version)
);
CREATE INDEX IF NOT EXISTS review_runs_workspace_time_idx
  ON review_runs (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS findings (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  pr_id text NOT NULL REFERENCES pull_requests(id),
  run_id text NOT NULL REFERENCES review_runs(id),
  fingerprint text NOT NULL,
  category text NOT NULL,
  severity text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  path text NOT NULL,
  line integer NOT NULL,
  evidence text NOT NULL,
  suggestion text NOT NULL,
  outcome text NOT NULL DEFAULT 'open',
  assessment text,
  fix_sha text,
  fixed_at timestamptz,
  thread_resolved boolean NOT NULL DEFAULT false,
  github_comment_id bigint,
  github_comment_url text,
  helpful boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pr_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS findings_workspace_pr_idx ON findings (workspace_id, pr_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  guid text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  event text NOT NULL,
  action text,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  dedup_key text NOT NULL UNIQUE,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz,
  lease_token text,
  sqs_enqueued_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_ready_idx ON jobs (state, available_at);

CREATE TABLE IF NOT EXISTS budget_months (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  month text NOT NULL,
  spent_usd numeric(12, 6) NOT NULL DEFAULT 0,
  reserved_usd numeric(12, 6) NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, month)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  action text NOT NULL,
  object_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;
