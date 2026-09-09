-- Trazabilidad Push -> Análisis -> Pull Request, y distinción entre un PR nativo
-- (abierto a mano en GitHub) y uno generado por la app a partir de un push analizado.
ALTER TABLE pull_requests
  ADD COLUMN source_review_run_id uuid REFERENCES review_runs (id),
  ADD COLUMN created_by text NOT NULL DEFAULT 'github' CHECK (created_by IN ('github', 'devsentinel'));

-- Creación automática de PR cuando un push a la rama origen sale APTO.
ALTER TABLE quality_gate_configs
  ADD COLUMN auto_create_pr_on_push boolean NOT NULL DEFAULT false;
