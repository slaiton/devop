-- Perfil de proyecto declarado por repo (lenguaje/framework/etc.), inyectado en el
-- prompt de la IA para calibrar sus hallazgos contra el stack real en vez de asumir
-- convenciones genéricas.
CREATE TABLE project_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  language text,
  framework text,
  framework_version text,
  runtime text,
  database text,
  architecture_style text,
  testing_strategy text,
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_id)
);

ALTER TABLE project_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON project_profiles
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- Autor del commit (para poder notificarlo por correo) y timestamp de notificación.
ALTER TABLE review_runs
  ADD COLUMN author_name text,
  ADD COLUMN author_email text,
  ADD COLUMN notified_at timestamptz;
