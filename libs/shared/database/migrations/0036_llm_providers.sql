-- Agentes de IA: antes había UN solo proveedor LLM (system_settings.llm_*). Ahora hay una lista
-- ordenada de proveedores (OpenAI, DeepSeek, Grok/xAI o cualquiera compatible con la API de OpenAI)
-- y un modo de uso:
--   failover    = se usa el primero activo; si falla, el siguiente (los demás son respaldo).
--   round_robin = se reparten los análisis entre los activos, por turnos; si uno falla, el
--                 siguiente en la rotación toma el trabajo.
-- Es configuración global del despliegue (como system_settings), por eso sin RLS.
CREATE TABLE llm_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'custom' CHECK (kind IN ('openai', 'deepseek', 'xai', 'custom')),
  base_url text NOT NULL,
  model text NOT NULL,
  api_key_encrypted text,
  -- Orden de uso (1 = primero). Sin UNIQUE a propósito: reordenar reescribe todas las posiciones
  -- en una sola sentencia y un índice único se violaría a mitad de camino.
  position int NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  last_used_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX llm_providers_position_idx ON llm_providers (position, created_at);

ALTER TABLE system_settings
  ADD COLUMN llm_routing_mode text NOT NULL DEFAULT 'failover' CHECK (llm_routing_mode IN ('failover', 'round_robin')),
  -- Turno del modo round_robin; se incrementa de forma atómica en cada análisis, compartido entre procesos.
  ADD COLUMN llm_rr_cursor bigint NOT NULL DEFAULT 0;

-- El proveedor único que ya estuviera configurado pasa a ser el agente #1.
INSERT INTO llm_providers (name, kind, base_url, model, api_key_encrypted, position)
SELECT
  CASE
    WHEN llm_provider_base_url ILIKE '%api.openai.com%' THEN 'OpenAI'
    WHEN llm_provider_base_url ILIKE '%deepseek%' THEN 'DeepSeek'
    WHEN llm_provider_base_url ILIKE '%x.ai%' THEN 'Grok (xAI)'
    ELSE 'Agente principal'
  END,
  CASE
    WHEN llm_provider_base_url ILIKE '%api.openai.com%' THEN 'openai'
    WHEN llm_provider_base_url ILIKE '%deepseek%' THEN 'deepseek'
    WHEN llm_provider_base_url ILIKE '%x.ai%' THEN 'xai'
    ELSE 'custom'
  END,
  llm_provider_base_url, llm_model, llm_provider_api_key_encrypted, 1
FROM system_settings
WHERE id = true AND llm_provider_base_url IS NOT NULL AND llm_provider_base_url <> '' AND llm_model IS NOT NULL AND llm_model <> '';

-- Qué agente respondió cada revisión y cuáles fallaron antes (si hubo que pasar al respaldo).
ALTER TABLE review_runs
  ADD COLUMN llm_provider text,
  ADD COLUMN llm_model text,
  ADD COLUMN llm_failovers jsonb;
