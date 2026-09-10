import type { Pool } from 'pg';
import { encrypt, decrypt } from './encryption';

export interface SystemSettings {
  githubAppId: string | null;
  githubAppSlug: string | null;
  githubAppClientId: string | null;
  githubAppClientSecret: string | null;
  githubAppPrivateKey: string | null;
  githubAppWebhookSecret: string | null;
  llmProviderBaseUrl: string | null;
  llmModel: string | null;
  llmProviderApiKey: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpUser: string | null;
  smtpFrom: string | null;
  smtpPassword: string | null;
}

const EMPTY_SETTINGS: SystemSettings = {
  githubAppId: null,
  githubAppSlug: null,
  githubAppClientId: null,
  githubAppClientSecret: null,
  githubAppPrivateKey: null,
  githubAppWebhookSecret: null,
  llmProviderBaseUrl: null,
  llmModel: null,
  llmProviderApiKey: null,
  smtpHost: null,
  smtpPort: null,
  smtpUser: null,
  smtpFrom: null,
  smtpPassword: null,
};

function decryptOrNull(value: string | null): string | null {
  return value ? decrypt(value) : null;
}

/** Lee la fila singleton de configuración del sistema, descifrando los secretos.
 * Devuelve `null` si todavía no se ha configurado nada (instalación nueva). */
export async function getSystemSettings(pool: Pool): Promise<SystemSettings | null> {
  const { rows } = await pool.query(
    `SELECT github_app_id, github_app_slug, github_app_client_id, github_app_client_secret_encrypted,
            github_app_private_key_encrypted, github_app_webhook_secret_encrypted,
            llm_provider_base_url, llm_model, llm_provider_api_key_encrypted,
            smtp_host, smtp_port, smtp_user, smtp_from, smtp_password_encrypted
     FROM system_settings WHERE id = true`,
  );
  const row = rows[0];
  if (!row) return null;

  return {
    githubAppId: row.github_app_id,
    githubAppSlug: row.github_app_slug,
    githubAppClientId: row.github_app_client_id,
    githubAppClientSecret: decryptOrNull(row.github_app_client_secret_encrypted),
    githubAppPrivateKey: decryptOrNull(row.github_app_private_key_encrypted),
    githubAppWebhookSecret: decryptOrNull(row.github_app_webhook_secret_encrypted),
    llmProviderBaseUrl: row.llm_provider_base_url,
    llmModel: row.llm_model,
    llmProviderApiKey: decryptOrNull(row.llm_provider_api_key_encrypted),
    smtpHost: row.smtp_host,
    smtpPort: row.smtp_port,
    smtpUser: row.smtp_user,
    smtpFrom: row.smtp_from,
    smtpPassword: decryptOrNull(row.smtp_password_encrypted),
  };
}

export function isConfigured(settings: SystemSettings | null): boolean {
  return Boolean(settings?.githubAppClientId && settings?.githubAppClientSecret);
}

/** Actualiza solo los campos presentes en `partial` (undefined = "no tocar"); dejar un
 * campo de secreto vacío en el formulario no borra el valor ya guardado. */
export async function updateSystemSettings(pool: Pool, partial: Partial<SystemSettings>): Promise<SystemSettings> {
  const current = (await getSystemSettings(pool)) ?? EMPTY_SETTINGS;
  const merged: SystemSettings = { ...current };
  for (const key of Object.keys(partial) as (keyof SystemSettings)[]) {
    const value = partial[key];
    if (value !== undefined && value !== '') {
      (merged as any)[key] = value;
    }
  }

  await pool.query(
    `INSERT INTO system_settings
       (id, github_app_id, github_app_slug, github_app_client_id, github_app_client_secret_encrypted,
        github_app_private_key_encrypted, github_app_webhook_secret_encrypted,
        llm_provider_base_url, llm_model, llm_provider_api_key_encrypted,
        smtp_host, smtp_port, smtp_user, smtp_from, smtp_password_encrypted, updated_at)
     VALUES (true, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
     ON CONFLICT (id) DO UPDATE SET
       github_app_id = $1, github_app_slug = $2, github_app_client_id = $3, github_app_client_secret_encrypted = $4,
       github_app_private_key_encrypted = $5, github_app_webhook_secret_encrypted = $6,
       llm_provider_base_url = $7, llm_model = $8, llm_provider_api_key_encrypted = $9,
       smtp_host = $10, smtp_port = $11, smtp_user = $12, smtp_from = $13, smtp_password_encrypted = $14,
       updated_at = now()`,
    [
      merged.githubAppId,
      merged.githubAppSlug,
      merged.githubAppClientId,
      merged.githubAppClientSecret ? encrypt(merged.githubAppClientSecret) : null,
      merged.githubAppPrivateKey ? encrypt(merged.githubAppPrivateKey) : null,
      merged.githubAppWebhookSecret ? encrypt(merged.githubAppWebhookSecret) : null,
      merged.llmProviderBaseUrl,
      merged.llmModel,
      merged.llmProviderApiKey ? encrypt(merged.llmProviderApiKey) : null,
      merged.smtpHost,
      merged.smtpPort,
      merged.smtpUser,
      merged.smtpFrom,
      merged.smtpPassword ? encrypt(merged.smtpPassword) : null,
    ],
  );

  return merged;
}

export { encrypt, decrypt } from './encryption';
