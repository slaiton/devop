-- Monitoreo de ramas por repo (arreglo vacío = todas, compatibilidad hacia atrás con
-- el comportamiento actual donde cualquier push dispara revisión) y rama origen/destino
-- de promoción (staging -> main por defecto).
ALTER TABLE repositories ADD COLUMN monitored_branches text[] NOT NULL DEFAULT '{}';

ALTER TABLE quality_gate_configs
  ADD COLUMN promotion_source_branch text NOT NULL DEFAULT 'staging',
  ADD COLUMN promotion_target_branch text NOT NULL DEFAULT 'main';

-- Rama del push y decisión de negocio explícita (distinta de risk_level, que es una
-- señal continua, no un veredicto binario).
ALTER TABLE review_runs
  ADD COLUMN branch text,
  ADD COLUMN gate_decision text CHECK (gate_decision IN ('apto', 'no_apto'));

-- Permite distinguir, por finding, cuáles causaron el bloqueo vs cuáles son solo
-- informativos.
ALTER TABLE findings ADD COLUMN blocking boolean NOT NULL DEFAULT false;

CREATE TABLE promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  review_run_id uuid NOT NULL REFERENCES review_runs (id) ON DELETE CASCADE,
  source_branch text NOT NULL,
  target_branch text NOT NULL,
  commit_sha text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by uuid NOT NULL REFERENCES users (id),
  decided_by uuid REFERENCES users (id),
  notes text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  UNIQUE (repository_id, commit_sha)
);

ALTER TABLE promotions ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON promotions
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

CREATE INDEX promotions_repo_idx ON promotions (repository_id, status);
