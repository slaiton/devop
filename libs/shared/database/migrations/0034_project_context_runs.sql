-- Corridas de "Generar contexto": el admin pide desde el repo que se lea su README / CLAUDE.md /
-- manifiestos y se arme (o complete) el perfil del proyecto con la IA. La generación corre en el
-- worker (llama a GitHub y al LLM, tarda decenas de segundos), así que la UI consulta esta fila
-- para mostrar "en curso / listo / falló" sin dejar una petición HTTP abierta.
CREATE TABLE project_context_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  -- fill: solo completa campos vacíos de un perfil curado; replace: pisa todo lo detectado.
  mode text NOT NULL DEFAULT 'fill' CHECK (mode IN ('fill', 'replace')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  sources text[] NOT NULL DEFAULT '{}',
  applied_fields text[] NOT NULL DEFAULT '{}',
  error_message text,
  requested_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX project_context_runs_repo_idx ON project_context_runs (repository_id, created_at DESC);

ALTER TABLE project_context_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON project_context_runs
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);
