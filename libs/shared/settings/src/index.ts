import type { Pool } from 'pg';
import { encrypt, decrypt } from './encryption';

export interface SystemSettings {
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
 * Devuelve `null` si todavía no se ha configurado nada (instalación nueva). Las
 * GitHub Apps ya NO viven acá — ver `@devsentinel/github-apps` y la tabla
 * `github_apps` (una organización puede conectar varias). */
export async function getSystemSettings(pool: Pool): Promise<SystemSettings | null> {
  const { rows } = await pool.query(
    `SELECT llm_provider_base_url, llm_model, llm_provider_api_key_encrypted,
            smtp_host, smtp_port, smtp_user, smtp_from, smtp_password_encrypted
     FROM system_settings WHERE id = true`,
  );
  const row = rows[0];
  if (!row) return null;

  return {
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
       (id, llm_provider_base_url, llm_model, llm_provider_api_key_encrypted,
        smtp_host, smtp_port, smtp_user, smtp_from, smtp_password_encrypted, updated_at)
     VALUES (true, $1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (id) DO UPDATE SET
       llm_provider_base_url = $1, llm_model = $2, llm_provider_api_key_encrypted = $3,
       smtp_host = $4, smtp_port = $5, smtp_user = $6, smtp_from = $7, smtp_password_encrypted = $8,
       updated_at = now()`,
    [
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
export { sendEmail, SmtpNotConfiguredError } from './email';
