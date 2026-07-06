CREATE TABLE quality_gate_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  repository_id uuid REFERENCES repositories (id) ON DELETE CASCADE,
  min_coverage_pct int NOT NULL DEFAULT 0,
  block_on_risk_level text NOT NULL DEFAULT 'high' CHECK (block_on_risk_level IN ('medium', 'high')),
  block_on_secret boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, repository_id)
);

ALTER TABLE quality_gate_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON quality_gate_configs
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

CREATE TABLE pipeline_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  review_run_id uuid NOT NULL REFERENCES review_runs (id) ON DELETE CASCADE,
  lint_passed boolean,
  tests_passed int,
  tests_failed int,
  coverage_pct numeric(5, 2),
  gate_passed boolean,
  blocking_reasons jsonb NOT NULL DEFAULT '[]',
  logs jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

ALTER TABLE pipeline_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON pipeline_runs
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

CREATE INDEX pipeline_runs_review_run_idx ON pipeline_runs (review_run_id);
