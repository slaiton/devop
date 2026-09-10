-- Configuración del sistema (GitHub App, LLM, SMTP) que antes vivía solo en variables
-- de entorno. Tabla singleton (id boolean con CHECK fuerza una única fila) — es
-- configuración global del despliegue, no por organización, por eso no lleva RLS.
CREATE TABLE system_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  github_app_id text,
  github_app_slug text,
  github_app_client_id text,
  github_app_client_secret_encrypted text,
  github_app_private_key_encrypted text,
  github_app_webhook_secret_encrypted text,
  llm_provider_base_url text,
  llm_model text,
  llm_provider_api_key_encrypted text,
  smtp_host text,
  smtp_port int,
  smtp_user text,
  smtp_from text,
  smtp_password_encrypted text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
