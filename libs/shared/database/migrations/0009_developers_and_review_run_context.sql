-- Entidad developer para poder evaluar contribuciones individuales con el tiempo.
-- Se identifica por login de GitHub (disponible en PRs) o por email de commit
-- (disponible en pushes) — no siempre hay ambos.
CREATE TABLE developers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  github_login text,
  email text,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE developers ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON developers
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

CREATE UNIQUE INDEX developers_org_login_idx ON developers (organization_id, github_login)
  WHERE github_login IS NOT NULL;
CREATE UNIQUE INDEX developers_org_email_idx ON developers (organization_id, email)
  WHERE email IS NOT NULL;

ALTER TABLE review_runs ADD COLUMN developer_id uuid REFERENCES developers (id);
