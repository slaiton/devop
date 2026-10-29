-- Amazon Bedrock como tipo de agente de IA (modelos de OpenAI servidos por Bedrock, p. ej. GPT-5.6 Sol).
-- Se llama con la API compatible con OpenAI de `bedrock-runtime` y una clave API de Bedrock, así que no
-- requiere columnas nuevas: solo ampliar los tipos permitidos.
ALTER TABLE llm_providers DROP CONSTRAINT IF EXISTS llm_providers_kind_check;
ALTER TABLE llm_providers
  ADD CONSTRAINT llm_providers_kind_check CHECK (kind IN ('openai', 'deepseek', 'xai', 'bedrock', 'custom'));
