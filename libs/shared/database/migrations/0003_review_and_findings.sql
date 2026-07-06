CREATE TABLE review_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  pull_request_id uuid REFERENCES pull_requests (id) ON DELETE CASCADE,
  commit_sha text NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('push', 'pull_request', 'manual')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  quality_score int CHECK (quality_score BETWEEN 0 AND 100),
  risk_level text CHECK (risk_level IN ('low', 'medium', 'high')),
  summary text,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

ALTER TABLE review_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON review_runs
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

CREATE INDEX review_runs_repo_idx ON review_runs (repository_id, started_at DESC);
CREATE INDEX review_runs_pr_idx ON review_runs (pull_request_id);

CREATE TABLE findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  review_run_id uuid NOT NULL REFERENCES review_runs (id) ON DELETE CASCADE,
  category text NOT NULL CHECK (
    category IN (
      'architecture', 'clean_code', 'solid', 'security', 'performance',
      'duplication', 'complexity', 'best_practice', 'documentation', 'test_coverage'
    )
  ),
  severity text NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  file_path text NOT NULL,
  line_start int,
  line_end int,
  title text NOT NULL,
  explanation text NOT NULL,
  suggested_fix jsonb,
  confidence numeric(3, 2),
  rule_source text NOT NULL DEFAULT 'llm' CHECK (rule_source IN ('llm', 'semgrep', 'gitleaks')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fixed', 'dismissed_false_positive')),
  github_comment_id bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE findings ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON findings
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

CREATE INDEX findings_review_run_idx ON findings (review_run_id);
CREATE INDEX findings_severity_idx ON findings (severity) WHERE status = 'open';

CREATE TABLE code_chunk_embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  file_path text NOT NULL,
  chunk_hash text NOT NULL,
  symbol_name text,
  content text NOT NULL,
  embedding vector (384) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_id, file_path, chunk_hash)
);

ALTER TABLE code_chunk_embeddings ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON code_chunk_embeddings
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

CREATE INDEX code_chunk_embeddings_vector_idx ON code_chunk_embeddings
  USING hnsw (embedding vector_cosine_ops);
