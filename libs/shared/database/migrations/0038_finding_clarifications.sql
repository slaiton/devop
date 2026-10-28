-- Preguntas de la IA al desarrollador. Cuando un hallazgo depende de algo que la IA no puede comprobar (por ejemplo si
-- otro repositorio o servicio ya se actualizó junto con el cambio), no lo declara bloqueante: lo deja como PREGUNTA
-- ('awaiting_clarification'). El desarrollador responde (en la plataforma o comentando en GitHub), la IA verifica lo que
-- pueda (incluidos otros repos de la misma instalación) y decide: confirmarlo (pasa a 'open' y bloquea según su
-- severidad), descartarlo, o repreguntar. Tras 2 rondas sin decidir queda para una persona (needs_human).
ALTER TABLE findings DROP CONSTRAINT findings_status_check;
ALTER TABLE findings ADD CONSTRAINT findings_status_check
  CHECK (status IN ('open', 'fixed', 'dismissed_false_positive', 'awaiting_clarification'));

ALTER TABLE findings
  ADD COLUMN question text,
  -- Qué repo/archivos revisaría la IA si se lo indican: {"repo": "owner/nombre", "paths": ["src/a.ts"]}
  ADD COLUMN verify_with jsonb,
  -- Cuántas preguntas de la IA van en este hallazgo (la primera es la ronda 1).
  ADD COLUMN clarification_round int NOT NULL DEFAULT 0,
  -- La IA ya preguntó lo que podía y no pudo decidir: una persona debe confirmar o descartar.
  ADD COLUMN needs_human boolean NOT NULL DEFAULT false,
  -- Cuándo se publicó la pregunta en GitHub (para no repetirla y para avisar solo de las nuevas).
  ADD COLUMN question_posted_at timestamptz;

CREATE TABLE finding_clarifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  finding_id uuid NOT NULL REFERENCES findings (id) ON DELETE CASCADE,
  -- 'ai' = pregunta o conclusión de la IA; 'developer' = respuesta de una persona; 'system' = decisión manual de un admin
  role text NOT NULL CHECK (role IN ('ai', 'developer', 'system')),
  body text NOT NULL,
  author_login text,
  posted_by uuid REFERENCES users (id),
  source text NOT NULL DEFAULT 'platform' CHECK (source IN ('platform', 'github', 'ai')),
  github_comment_id bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE finding_clarifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON finding_clarifications
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

CREATE INDEX finding_clarifications_finding_idx ON finding_clarifications (finding_id, created_at);
-- El webhook de GitHub puede llegar repetido: el mismo comentario no se registra dos veces para el mismo hallazgo.
CREATE UNIQUE INDEX finding_clarifications_github_idx ON finding_clarifications (finding_id, github_comment_id) WHERE github_comment_id IS NOT NULL;

-- "¿Este commit tiene preguntas pendientes?" se consulta en listas de pushes y en el aviso en vivo.
CREATE INDEX findings_awaiting_idx ON findings (review_run_id) WHERE status = 'awaiting_clarification';
