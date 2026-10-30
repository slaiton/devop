-- Límites de contexto por agente de IA. Cada solicitud se comprueba ANTES de enviarla: tokens estimados de la entrada contra
-- (ventana − tokens reservados para la respuesta), con margen de seguridad. NULL = valor por defecto del despliegue
-- (LLM_DEFAULT_CONTEXT_TOKENS = 272000, LLM_DEFAULT_OUTPUT_TOKENS = 16000), pensado para no superar los 272K de entrada que
-- Bedrock cobra al doble.
ALTER TABLE llm_providers
  ADD COLUMN context_window_tokens int CHECK (context_window_tokens BETWEEN 8000 AND 4000000),
  ADD COLUMN max_output_tokens int CHECK (max_output_tokens BETWEEN 256 AND 1000000);
