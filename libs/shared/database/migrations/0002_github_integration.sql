CREATE TABLE github_installations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  installation_id bigint NOT NULL UNIQUE,
  account_login text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE github_installations ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON github_installations
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

CREATE TABLE repositories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  github_installation_id uuid NOT NULL REFERENCES github_installations (id) ON DELETE CASCADE,
  github_repo_id bigint NOT NULL UNIQUE,
  full_name text NOT NULL,
  default_branch text NOT NULL DEFAULT 'main',
  webhook_status text NOT NULL DEFAULT 'pending' CHECK (webhook_status IN ('pending', 'active', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE repositories ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON repositories
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

CREATE INDEX repositories_installation_idx ON repositories (github_installation_id);

CREATE TABLE pull_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  github_pr_number int NOT NULL,
  title text NOT NULL,
  source_branch text NOT NULL,
  target_branch text NOT NULL,
  author_login text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'merged', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  merged_at timestamptz,
  UNIQUE (repository_id, github_pr_number)
);

ALTER TABLE pull_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON pull_requests
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

CREATE INDEX pull_requests_repo_idx ON pull_requests (repository_id, status);
