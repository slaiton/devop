import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { getPool } from '@devsentinel/database';
import {
  LLM_AUDIT_LAYERS,
  LLM_PROVIDER_KINDS,
  LLM_ROUTING_MODES,
  encrypt,
  getLlmProvider,
  getLlmRoutingMode,
  listLlmProviders,
  recordLlmProviderResult,
  setLlmRoutingMode,
  type LlmAuditLayer,
  type LlmProviderConfig,
  type LlmProviderKind,
  type LlmRoutingMode,
} from '@devsentinel/settings';

export interface LlmProviderInput {
  name?: string;
  kind?: string;
  baseUrl?: string;
  model?: string;
  /** undefined o '' = no tocar la clave guardada. */
  apiKey?: string;
  clearApiKey?: boolean;
  enabled?: boolean;
  /** null / '' / 'general' = agente general; 'layer2' | 'layer3' = atiende esa capa de la auditoría. */
  auditLayer?: string | null;
}

const TEST_TIMEOUT_MS = 25_000;

function requireKind(kind: unknown): LlmProviderKind {
  if (typeof kind !== 'string' || !(LLM_PROVIDER_KINDS as readonly string[]).includes(kind)) {
    throw new BadRequestException(`kind debe ser uno de: ${LLM_PROVIDER_KINDS.join(', ')}`);
  }
  return kind as LlmProviderKind;
}

function cleanLayer(raw: unknown): LlmAuditLayer | null {
  if (raw === null || raw === undefined || raw === '' || raw === 'general') return null;
  if (typeof raw !== 'string' || !(LLM_AUDIT_LAYERS as readonly string[]).includes(raw)) {
    throw new BadRequestException(`auditLayer debe ser vacío (general) o uno de: ${LLM_AUDIT_LAYERS.join(', ')}`);
  }
  return raw as LlmAuditLayer;
}

function cleanBaseUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new BadRequestException('falta la URL base del agente');
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new BadRequestException('la URL base no es válida (ej. https://api.openai.com/v1)');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new BadRequestException('la URL base debe ser http(s)');
  if (url.username || url.password) throw new BadRequestException('la URL base no debe llevar usuario ni contraseña (la clave va en su propio campo)');
  return url.toString().replace(/\/+$/, '');
}

function cleanText(raw: unknown, label: string, max: number): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new BadRequestException(`falta ${label}`);
  if (raw.trim().length > max) throw new BadRequestException(`${label} es demasiado largo (máximo ${max} caracteres)`);
  return raw.trim();
}

/** Lo que ve la interfaz: nunca la clave, solo si hay una guardada. */
export function toMaskedProvider(p: LlmProviderConfig) {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    baseUrl: p.baseUrl,
    model: p.model,
    apiKeySet: Boolean(p.apiKey),
    position: p.position,
    enabled: p.enabled,
    lastUsedAt: p.lastUsedAt,
    lastError: p.lastError,
    lastErrorAt: p.lastErrorAt,
    auditLayer: p.auditLayer,
  };
}

/** Agentes de IA (proveedores de LLM) y cómo se reparte el trabajo entre ellos. Configuración global del
 * despliegue; el worker la lee en cada análisis (ver `createLlmRouter`). */
@Injectable()
export class LlmProvidersService {
  async get() {
    const pool = getPool();
    const [mode, providers] = await Promise.all([getLlmRoutingMode(pool), listLlmProviders(pool)]);
    return { mode, providers: providers.map(toMaskedProvider) };
  }

  async setMode(mode: unknown) {
    if (typeof mode !== 'string' || !(LLM_ROUTING_MODES as readonly string[]).includes(mode)) {
      throw new BadRequestException(`mode debe ser uno de: ${LLM_ROUTING_MODES.join(', ')}`);
    }
    await setLlmRoutingMode(getPool(), mode as LlmRoutingMode);
    return this.get();
  }

  async create(input: LlmProviderInput) {
    const kind = requireKind(input.kind);
    const name = cleanText(input.name, 'el nombre', 60);
    const baseUrl = cleanBaseUrl(input.baseUrl);
    const model = cleanText(input.model, 'el modelo', 120);
    const apiKey = input.apiKey?.trim() || null;
    const auditLayer = cleanLayer(input.auditLayer);
    const pool = getPool();
    await pool.query(
      `INSERT INTO llm_providers (name, kind, base_url, model, api_key_encrypted, enabled, position, audit_layer)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE((SELECT max(position) FROM llm_providers), 0) + 1, $7)`,
      [name, kind, baseUrl, model, apiKey ? encrypt(apiKey) : null, input.enabled ?? true, auditLayer],
    );
    return this.get();
  }

  async update(id: string, input: LlmProviderInput) {
    const current = await getLlmProvider(getPool(), id);
    if (!current) throw new NotFoundException('agente no encontrado');
    const kind = input.kind !== undefined ? requireKind(input.kind) : current.kind;
    const name = input.name !== undefined ? cleanText(input.name, 'el nombre', 60) : current.name;
    const baseUrl = input.baseUrl !== undefined ? cleanBaseUrl(input.baseUrl) : current.baseUrl;
    const model = input.model !== undefined ? cleanText(input.model, 'el modelo', 120) : current.model;
    const enabled = input.enabled !== undefined ? Boolean(input.enabled) : current.enabled;
    const auditLayer = input.auditLayer !== undefined ? cleanLayer(input.auditLayer) : current.auditLayer;
    let keyEncrypted: string | null | undefined; // undefined = no tocar
    if (input.clearApiKey) keyEncrypted = null;
    else if (input.apiKey && input.apiKey.trim()) keyEncrypted = encrypt(input.apiKey.trim());

    await getPool().query(
      `UPDATE llm_providers
       SET name = $2, kind = $3, base_url = $4, model = $5, enabled = $6,
           api_key_encrypted = CASE WHEN $7::boolean THEN $8 ELSE api_key_encrypted END,
           audit_layer = $9,
           updated_at = now()
       WHERE id = $1`,
      [id, name, kind, baseUrl, model, enabled, keyEncrypted !== undefined, keyEncrypted ?? null, auditLayer],
    );
    return this.get();
  }

  async remove(id: string) {
    const pool = getPool();
    const { rowCount } = await pool.query('DELETE FROM llm_providers WHERE id = $1', [id]);
    if (!rowCount) throw new NotFoundException('agente no encontrado');
    // Posiciones consecutivas (1..n) para que "el orden" no quede con huecos
    await pool.query(
      `UPDATE llm_providers p SET position = r.pos
       FROM (SELECT id, row_number() OVER (ORDER BY position, created_at) AS pos FROM llm_providers) r
       WHERE p.id = r.id`,
    );
    return this.get();
  }

  /** `ids` debe ser exactamente el conjunto de agentes, en el orden deseado (el primero se usa primero). */
  async reorder(ids: unknown) {
    if (!Array.isArray(ids) || ids.some((i) => typeof i !== 'string')) throw new BadRequestException('ids debe ser una lista de identificadores');
    const pool = getPool();
    const existing = (await listLlmProviders(pool)).map((p) => p.id);
    const same = ids.length === existing.length && new Set(ids).size === ids.length && existing.every((id) => ids.includes(id));
    if (!same) throw new BadRequestException('la lista debe incluir todos los agentes, sin repetir ni agregar otros');
    await pool.query(
      `UPDATE llm_providers p SET position = o.ord
       FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, ord)
       WHERE p.id = o.id`,
      [ids],
    );
    return this.get();
  }

  /** Hace una consulta mínima al agente para saber si la URL, el modelo y la clave funcionan. Va por
   * `fetch` simple (no por el SDK) para que el mensaje de error sea el del proveedor, sin interpretar. */
  async test(id: string) {
    const provider = await getLlmProvider(getPool(), id);
    if (!provider) throw new NotFoundException('agente no encontrado');
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}) },
        body: JSON.stringify({ model: provider.model, messages: [{ role: 'user', content: 'Responde solo con la palabra: ok' }] }),
      });
      const latencyMs = Date.now() - started;
      const text = await res.text();
      if (!res.ok) {
        const error = this.describeHttpError(res.status, text);
        await recordLlmProviderResult(getPool(), id, false, error);
        return { ok: false, latencyMs, status: res.status, error };
      }
      let reply = '';
      try {
        reply = String(JSON.parse(text).choices?.[0]?.message?.content ?? '').trim().slice(0, 80);
      } catch {
        // respuesta 200 que no es JSON de OpenAI: se avisa abajo
      }
      if (!reply) {
        const error = 'el servicio respondió, pero no con el formato de la API de OpenAI (chat/completions)';
        await recordLlmProviderResult(getPool(), id, false, error);
        return { ok: false, latencyMs, status: res.status, error };
      }
      await recordLlmProviderResult(getPool(), id, true);
      return { ok: true, latencyMs, reply };
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError';
      const error = aborted ? `no respondió en ${TEST_TIMEOUT_MS / 1000} s` : `no se pudo conectar: ${(err as Error).message}`;
      await recordLlmProviderResult(getPool(), id, false, error);
      return { ok: false, latencyMs: Date.now() - started, status: null, error };
    } finally {
      clearTimeout(timer);
    }
  }

  private describeHttpError(status: number, body: string): string {
    let detail = '';
    try {
      const parsed = JSON.parse(body);
      detail = String(parsed?.error?.message ?? parsed?.message ?? '').slice(0, 200);
    } catch {
      detail = body.replace(/\s+/g, ' ').slice(0, 160);
    }
    const hint =
      status === 401 || status === 403
        ? ' — revisa la API key'
        : status === 404
          ? ' — revisa la URL base y el nombre del modelo'
          : status === 429
            ? ' — límite de uso o saldo agotado'
            : '';
    return `HTTP ${status}${detail ? `: ${detail}` : ''}${hint}`;
  }
}
