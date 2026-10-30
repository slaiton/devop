-- Auditoría por capas — capa 2 (triaje con un modelo barato), asignación de modelo por capa, costos y presupuesto.
-- Todo es aditivo: sin activar la capa 2 en un repo, nada cambia.

-- 1) Qué agente de IA atiende cada capa. NULL = agente general (el reparto de siempre: respaldo o por turnos). Un agente
--    asignado a una capa queda fuera de la rotación general.
ALTER TABLE llm_providers
  ADD COLUMN audit_layer text CHECK (audit_layer IN ('layer2', 'layer3'));

-- 2) La capa 2 se activa por repositorio (requiere la capa 1).
ALTER TABLE quality_gate_configs
  ADD COLUMN audit_layer2 boolean NOT NULL DEFAULT false;

-- 3) Presupuesto de IA del despliegue (un solo tope para toda la cuenta de AWS/proveedor).
--    partial = si no alcanza el presupuesto, esa capa no corre, la auditoría queda INCOMPLETA y nunca sale APTO.
--    block   = igual, y además el commit queda NO APTO.
ALTER TABLE system_settings
  ADD COLUMN audit_monthly_budget_usd numeric(10, 2) NOT NULL DEFAULT 50 CHECK (audit_monthly_budget_usd >= 0),
  ADD COLUMN audit_max_cost_per_audit_usd numeric(10, 2) NOT NULL DEFAULT 1 CHECK (audit_max_cost_per_audit_usd >= 0),
  ADD COLUMN audit_budget_policy text NOT NULL DEFAULT 'partial' CHECK (audit_budget_policy IN ('partial', 'block'));

-- 4) Tarifas por modelo. NO están en el código: son datos editables. Valores iniciales tomados de las fichas de modelo de
--    Amazon Bedrock (USD por millón de tokens, nivel Standard); verifícalos contra la página de precios de Bedrock y
--    actualiza aquí cuando cambien (una fila nueva con otra effective_from; se usa la vigente más reciente).
--    inference: 'us' = perfil geográfico us.*, 'global' = perfil global.*, 'in_region' = región fija.
--    context_tier: 'short' = hasta 272K tokens de entrada; 'long' = más (la tarifa aplica a toda la solicitud).
CREATE TABLE model_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_key text NOT NULL,
  inference text NOT NULL CHECK (inference IN ('us', 'global', 'in_region')),
  context_tier text NOT NULL CHECK (context_tier IN ('short', 'long')),
  input_per_mtok numeric(12, 6) NOT NULL,
  cache_write_per_mtok numeric(12, 6) NOT NULL,
  cache_read_per_mtok numeric(12, 6) NOT NULL,
  output_per_mtok numeric(12, 6) NOT NULL,
  source text,
  effective_from timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model_key, inference, context_tier, effective_from)
);

INSERT INTO model_prices (model_key, inference, context_tier, input_per_mtok, cache_write_per_mtok, cache_read_per_mtok, output_per_mtok, source, effective_from) VALUES
  ('gpt-5.6-luna', 'us',        'short', 0.22, 0.275, 0.022, 1.32, 'ficha de modelo Bedrock (GPT-5.6 Luna), geo CRIS', '2026-07-13'),
  ('gpt-5.6-luna', 'us',        'long',  0.44, 0.55,  0.044, 1.98, 'ficha de modelo Bedrock (GPT-5.6 Luna), geo CRIS', '2026-07-13'),
  ('gpt-5.6-luna', 'global',    'short', 0.20, 0.25,  0.02,  1.20, 'ficha de modelo Bedrock (GPT-5.6 Luna), global CRIS', '2026-07-13'),
  ('gpt-5.6-luna', 'global',    'long',  0.40, 0.50,  0.04,  1.80, 'ficha de modelo Bedrock (GPT-5.6 Luna), global CRIS', '2026-07-13'),
  ('gpt-5.6-luna', 'in_region', 'short', 0.22, 0.275, 0.022, 1.32, 'ficha de modelo Bedrock (GPT-5.6 Luna), in-region', '2026-07-13'),
  ('gpt-5.6-luna', 'in_region', 'long',  0.44, 0.55,  0.044, 1.98, 'ficha de modelo Bedrock (GPT-5.6 Luna), in-region', '2026-07-13'),
  ('gpt-5.6-sol',  'us',        'short', 4.40, 5.50,  0.44,  22.00, 'ficha de modelo Bedrock (GPT-5.6 Sol), geo CRIS', '2026-07-13'),
  ('gpt-5.6-sol',  'us',        'long',  8.80, 11.00, 0.88,  33.00, 'ficha de modelo Bedrock (GPT-5.6 Sol), geo CRIS', '2026-07-13'),
  ('gpt-5.6-sol',  'global',    'short', 4.00, 5.00,  0.40,  20.00, 'ficha de modelo Bedrock (GPT-5.6 Sol), global CRIS', '2026-07-13'),
  ('gpt-5.6-sol',  'global',    'long',  8.00, 10.00, 0.80,  30.00, 'ficha de modelo Bedrock (GPT-5.6 Sol), global CRIS', '2026-07-13'),
  ('gpt-5.6-sol',  'in_region', 'short', 4.40, 5.50,  0.44,  22.00, 'ficha de modelo Bedrock (GPT-5.6 Sol), in-region', '2026-07-13'),
  ('gpt-5.6-sol',  'in_region', 'long',  8.80, 11.00, 0.88,  33.00, 'ficha de modelo Bedrock (GPT-5.6 Sol), in-region', '2026-07-13');

-- 5) Cada llamada a un modelo: tokens, costo estimado con la tarifa vigente, latencia y errores. Sin prompts ni respuestas.
CREATE TABLE llm_invocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  review_run_id uuid REFERENCES review_runs (id) ON DELETE CASCADE,
  repository_id uuid REFERENCES repositories (id) ON DELETE SET NULL,
  -- layer2 / layer3 / review (revisor general) / otras tareas (reconsider, clarification, issue_reply, project_profile)
  purpose text NOT NULL,
  method text,
  provider_id uuid,
  provider_name text,
  model text NOT NULL,
  prompt_tokens int NOT NULL DEFAULT 0,
  completion_tokens int NOT NULL DEFAULT 0,
  cached_tokens int NOT NULL DEFAULT 0,
  cache_write_tokens int NOT NULL DEFAULT 0,
  reasoning_tokens int NOT NULL DEFAULT 0,
  -- NULL = el modelo no tiene tarifa cargada en model_prices (no se puede contabilizar ni limitar)
  cost_usd numeric(12, 6),
  price_id uuid REFERENCES model_prices (id),
  latency_ms int,
  ok boolean NOT NULL DEFAULT true,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Sin RLS a propósito (como llm_providers y system_settings): el presupuesto es del despliegue, una sola cuenta de AWS para todas las
-- organizaciones, así que el gasto del mes se suma entre todas. No guarda prompts ni respuestas, solo consumo; organization_id es atribución.
CREATE INDEX llm_invocations_review_idx ON llm_invocations (review_run_id);
CREATE INDEX llm_invocations_created_idx ON llm_invocations (created_at);

-- 6) Resultado de la capa 2 y recomendación de escalamiento, en la revisión.
ALTER TABLE review_runs
  ADD COLUMN audit_layer2 jsonb,
  ADD COLUMN audit_escalation jsonb;

-- 7) Hallazgos que vienen de la capa 2 (o 3): su origen, su estado de validación y a qué hallazgos de la capa 1 se refieren.
ALTER TABLE findings DROP CONSTRAINT IF EXISTS findings_rule_source_check;
ALTER TABLE findings
  ADD CONSTRAINT findings_rule_source_check CHECK (rule_source IN ('llm', 'semgrep', 'gitleaks', 'layer2', 'layer3')),
  ADD COLUMN validation_status text CHECK (validation_status IN ('confirmed', 'pending_validation', 'accepted_exception', 'false_positive_suspected')),
  ADD COLUMN audit_refs jsonb;

-- 8) Lo que la capa 2 opinó de cada hallazgo de la capa 1 (grupo, prioridad, motivo de descarte).
ALTER TABLE scan_findings
  ADD COLUMN triage jsonb;
