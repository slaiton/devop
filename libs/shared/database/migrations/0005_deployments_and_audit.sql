CREATE TABLE environments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name IN ('development', 'qa', 'staging', 'production')),
  current_version text,
  status text NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy', 'degraded', 'deploying')),
  UNIQUE (repository_id, name)
);

ALTER TABLE environments ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON environments
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

CREATE TABLE deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  environment_id uuid NOT NULL REFERENCES environments (id) ON DELETE CASCADE,
  version text NOT NULL,
  commit_sha text,
  triggered_by uuid REFERENCES users (id),
  status text NOT NULL DEFAULT 'succeeded' CHECK (status IN ('pending', 'succeeded', 'failed', 'rolled_back')),
  notes text,
  deployed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE deployments ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON deployments
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

CREATE INDEX deployments_environment_idx ON deployments (environment_id, deployed_at DESC);

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  actor text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON audit_logs
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

CREATE INDEX audit_logs_org_idx ON audit_logs (organization_id, occurred_at DESC);
