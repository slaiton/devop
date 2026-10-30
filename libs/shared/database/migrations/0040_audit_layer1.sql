-- Auditoría por capas — capa 1: escáneres deterministas (Semgrep, Gitleaks, Trivy, Checkov, Hadolint).
-- Todo es aditivo: ningún repositorio cambia de comportamiento hasta que un admin active la capa 1 en su configuración.

-- Por repositorio (o por organización, con repository_id NULL, como el resto de la configuración del gate).
ALTER TABLE quality_gate_configs
  ADD COLUMN audit_layer1 boolean NOT NULL DEFAULT false;

-- Estado de ejecución de la auditoría, separado del resultado de calidad/seguridad (gate_decision).
-- audit_incomplete = true cuando algún escáner obligatorio y aplicable no corrió bien: una auditoría
-- incompleta nunca se presenta como APTO.
ALTER TABLE review_runs
  ADD COLUMN audit_stage text CHECK (audit_stage IN
    ('pending', 'running_layer_1', 'running_layer_2', 'running_layer_3', 'completed', 'failed', 'cancelled')),
  ADD COLUMN audit_incomplete boolean NOT NULL DEFAULT false,
  ADD COLUMN audit_coverage jsonb;

-- Una fila por escáner por revisión: qué se ejecutó, con qué versión exacta y cómo terminó.
-- 'skipped' = no aplica a este repo (con el motivo); 'failed' / 'timeout' / 'not_installed' NO son un resultado limpio.
CREATE TABLE scanner_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  review_run_id uuid NOT NULL REFERENCES review_runs (id) ON DELETE CASCADE,
  tool text NOT NULL CHECK (tool IN ('semgrep', 'gitleaks', 'trivy', 'checkov', 'hadolint')),
  status text NOT NULL CHECK (status IN ('ok', 'failed', 'timeout', 'skipped', 'not_installed')),
  mandatory boolean NOT NULL DEFAULT true,
  reason text,
  scanner_version text,
  image text,
  image_digest text,
  ruleset text,
  ruleset_pinned boolean NOT NULL DEFAULT false,
  duration_ms int,
  exit_code int,
  error text,
  findings_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE scanner_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON scanner_runs
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);
CREATE INDEX scanner_runs_review_idx ON scanner_runs (review_run_id);

-- Hallazgos normalizados de la capa 1, ya deduplicados entre herramientas. `fingerprint` se calcula sobre el
-- contenido (no sobre el número de línea) para que una misma vulnerabilidad se reconozca entre commits y se pueda
-- aceptar como excepción. La evidencia está redactada: nunca contiene un secreto.
CREATE TABLE scan_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  review_run_id uuid NOT NULL REFERENCES review_runs (id) ON DELETE CASCADE,
  tool text NOT NULL,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  rule_id text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  category text NOT NULL CHECK (category IN ('secret', 'sast', 'dependency', 'iac', 'dockerfile')),
  file_path text NOT NULL,
  line_start int,
  line_end int,
  title text NOT NULL,
  message text NOT NULL,
  evidence text,
  vuln_id text,
  cwe text,
  package_name text,
  installed_version text,
  fixed_version text,
  fingerprint text NOT NULL,
  baseline_status text NOT NULL DEFAULT 'unknown' CHECK (baseline_status IN ('new', 'preexisting', 'unknown')),
  validation_status text NOT NULL DEFAULT 'pending_validation'
    CHECK (validation_status IN ('confirmed', 'pending_validation', 'accepted_exception', 'false_positive_suspected')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE scan_findings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON scan_findings
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);
CREATE INDEX scan_findings_review_idx ON scan_findings (review_run_id, severity);
CREATE INDEX scan_findings_fingerprint_idx ON scan_findings (organization_id, fingerprint);
