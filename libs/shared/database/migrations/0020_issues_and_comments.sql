-- Espejo local de GitHub Issues (todo issue del repo, no solo los que crea
-- DevSentinel) y de sus comentarios, para poder gestionarlos desde el dashboard sin
-- depender de abrir github.com. Ver docs de la feature en el plan de implementación.
CREATE TABLE issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  github_issue_number int NOT NULL,
  pull_request_id uuid REFERENCES pull_requests (id) ON DELETE SET NULL,
  branch text,
  review_run_id uuid REFERENCES review_runs (id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'findings' CHECK (kind IN ('findings', 'manual')),
  origin text NOT NULL DEFAULT 'github' CHECK (origin IN ('github', 'devsentinel')),
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  state_reason text,
  author_login text,
  ai_suggested_reply text,
  ai_suggested_reply_status text CHECK (ai_suggested_reply_status IN ('pending', 'ready', 'failed')),
  ai_suggested_reply_requested_by uuid REFERENCES users (id),
  ai_suggested_reply_requested_at timestamptz,
  ai_suggested_reply_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  last_synced_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE issues ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON issues
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- Idempotencia frente a GitHub: toda escritura (webhook o llamada propia) upsertea por
-- esta clave, sin importar quién creó el issue.
CREATE UNIQUE INDEX issues_repo_number_idx ON issues (repository_id, github_issue_number);

-- Idempotencia de negocio: un único issue "findings" por PR, y otro por branch cuando
-- no hay PR — evita duplicados entre creación automática, botón manual y reconsideraciones.
CREATE UNIQUE INDEX issues_findings_pr_idx ON issues (repository_id, pull_request_id)
  WHERE kind = 'findings' AND pull_request_id IS NOT NULL;
CREATE UNIQUE INDEX issues_findings_branch_idx ON issues (repository_id, branch)
  WHERE kind = 'findings' AND pull_request_id IS NULL AND branch IS NOT NULL;

CREATE INDEX issues_repo_state_idx ON issues (repository_id, state);
CREATE INDEX issues_review_run_idx ON issues (review_run_id);

CREATE TABLE issue_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  issue_id uuid NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  github_comment_id bigint,
  author_login text,
  body text NOT NULL,
  -- 'devsentinel' = se publicó a través de nuestro endpoint (independiente de si el
  -- texto lo escribió un humano o vino de una sugerencia de IA editada); 'github' =
  -- llegó por webhook sin pasar por nuestra API (comentario nativo en github.com).
  source text NOT NULL DEFAULT 'github' CHECK (source IN ('github', 'devsentinel')),
  posted_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  deleted_at timestamptz
);

ALTER TABLE issue_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON issue_comments
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

CREATE UNIQUE INDEX issue_comments_github_idx ON issue_comments (issue_id, github_comment_id)
  WHERE github_comment_id IS NOT NULL;
CREATE INDEX issue_comments_issue_idx ON issue_comments (issue_id, created_at);
