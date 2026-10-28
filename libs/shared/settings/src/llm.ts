import type { Pool } from 'pg';
import { decrypt } from './encryption';

/** Tipos de agente. `custom` es cualquier servicio compatible con la API de OpenAI. */
export const LLM_PROVIDER_KINDS = ['openai', 'deepseek', 'xai', 'custom'] as const;
export type LlmProviderKind = (typeof LLM_PROVIDER_KINDS)[number];

/** failover = el primero activo y los demás de respaldo; round_robin = se intercalan por turnos. */
export const LLM_ROUTING_MODES = ['failover', 'round_robin'] as const;
export type LlmRoutingMode = (typeof LLM_ROUTING_MODES)[number];

export interface LlmProviderConfig {
  id: string;
  name: string;
  kind: LlmProviderKind;
  baseUrl: string;
  model: string;
  /** Descifrada. Nunca se devuelve tal cual a la UI. */
  apiKey: string | null;
  position: number;
  enabled: boolean;
  lastUsedAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
}

interface Row {
  id: string;
  name: string;
  kind: LlmProviderKind;
  base_url: string;
  model: string;
  api_key_encrypted: string | null;
  position: number;
  enabled: boolean;
  last_used_at: Date | null;
  last_error: string | null;
  last_error_at: Date | null;
}

function toConfig(row: Row): LlmProviderConfig {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.base_url,
    model: row.model,
    apiKey: row.api_key_encrypted ? decrypt(row.api_key_encrypted) : null,
    position: row.position,
    enabled: row.enabled,
    lastUsedAt: row.last_used_at,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
  };
}

const COLUMNS = `id, name, kind, base_url, model, api_key_encrypted, position, enabled, last_used_at, last_error, last_error_at`;

/** Agentes configurados, en el orden de uso (posición 1 primero). */
export async function listLlmProviders(pool: Pool, options: { onlyEnabled?: boolean } = {}): Promise<LlmProviderConfig[]> {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM llm_providers ${options.onlyEnabled ? 'WHERE enabled' : ''} ORDER BY position, created_at`,
  );
  return rows.map(toConfig);
}

export async function getLlmProvider(pool: Pool, id: string): Promise<LlmProviderConfig | null> {
  const { rows } = await pool.query(`SELECT ${COLUMNS} FROM llm_providers WHERE id = $1`, [id]);
  return rows[0] ? toConfig(rows[0]) : null;
}

export async function getLlmRoutingMode(pool: Pool): Promise<LlmRoutingMode> {
  const { rows } = await pool.query(`SELECT llm_routing_mode FROM system_settings WHERE id = true`);
  return rows[0]?.llm_routing_mode === 'round_robin' ? 'round_robin' : 'failover';
}

export async function setLlmRoutingMode(pool: Pool, mode: LlmRoutingMode): Promise<void> {
  await pool.query(
    `INSERT INTO system_settings (id, llm_routing_mode, updated_at) VALUES (true, $1, now())
     ON CONFLICT (id) DO UPDATE SET llm_routing_mode = $1, updated_at = now()`,
    [mode],
  );
}

/** Siguiente turno del modo round_robin. Atómico en la base: varios workers (o varios análisis a la
 * vez) nunca reciben el mismo número, así la rotación es pareja aunque haya concurrencia. */
export async function nextLlmTurn(pool: Pool): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO system_settings (id, llm_rr_cursor) VALUES (true, 1)
     ON CONFLICT (id) DO UPDATE SET llm_rr_cursor = system_settings.llm_rr_cursor + 1
     RETURNING llm_rr_cursor`,
  );
  return Number(rows[0].llm_rr_cursor);
}

/** Deja constancia en el agente de su último uso o su último error (para verlo en la pantalla de
 * configuración). Es información auxiliar: un fallo al escribirla nunca debe afectar al análisis. */
export async function recordLlmProviderResult(pool: Pool, id: string, ok: boolean, error?: string): Promise<void> {
  if (ok) {
    await pool.query(`UPDATE llm_providers SET last_used_at = now() WHERE id = $1`, [id]);
  } else {
    await pool.query(`UPDATE llm_providers SET last_error = $2, last_error_at = now() WHERE id = $1`, [id, (error ?? 'error').slice(0, 500)]);
  }
}
