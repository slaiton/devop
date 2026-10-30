import type { Pool, PoolClient } from 'pg';

/** Presupuesto de IA y contabilidad de costos de la auditoría por capas. Las tarifas viven en la tabla `model_prices`
 * (datos editables), nunca en el código: cuando Bedrock cambie un precio se agrega una fila. */

export type BudgetPolicy = 'partial' | 'block';

export interface AuditBudget {
  monthlyUsd: number;
  perAuditUsd: number;
  policy: BudgetPolicy;
}

export const DEFAULT_AUDIT_BUDGET: AuditBudget = { monthlyUsd: 50, perAuditUsd: 1, policy: 'partial' };

type Queryable = Pick<Pool | PoolClient, 'query'>;

export async function getAuditBudget(db: Queryable): Promise<AuditBudget> {
  const { rows } = await db.query(
    `SELECT audit_monthly_budget_usd, audit_max_cost_per_audit_usd, audit_budget_policy FROM system_settings WHERE id = true`,
  );
  const row = rows[0];
  if (!row) return DEFAULT_AUDIT_BUDGET;
  return {
    monthlyUsd: Number(row.audit_monthly_budget_usd),
    perAuditUsd: Number(row.audit_max_cost_per_audit_usd),
    policy: row.audit_budget_policy === 'block' ? 'block' : 'partial',
  };
}

export async function setAuditBudget(db: Queryable, partial: Partial<AuditBudget>): Promise<AuditBudget> {
  const current = await getAuditBudget(db);
  const merged: AuditBudget = {
    monthlyUsd: partial.monthlyUsd ?? current.monthlyUsd,
    perAuditUsd: partial.perAuditUsd ?? current.perAuditUsd,
    policy: partial.policy ?? current.policy,
  };
  await db.query(
    `INSERT INTO system_settings (id, audit_monthly_budget_usd, audit_max_cost_per_audit_usd, audit_budget_policy, updated_at)
     VALUES (true, $1, $2, $3, now())
     ON CONFLICT (id) DO UPDATE SET audit_monthly_budget_usd = $1, audit_max_cost_per_audit_usd = $2, audit_budget_policy = $3, updated_at = now()`,
    [merged.monthlyUsd, merged.perAuditUsd, merged.policy],
  );
  return merged;
}

export interface ModelPrice {
  id: string;
  modelKey: string;
  inference: 'us' | 'global' | 'in_region';
  contextTier: 'short' | 'long';
  inputPerMtok: number;
  cacheWritePerMtok: number;
  cacheReadPerMtok: number;
  outputPerMtok: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
}

/** Por encima de este tamaño de entrada Bedrock cobra la tarifa de contexto largo sobre TODA la solicitud. */
export const LONG_CONTEXT_THRESHOLD_TOKENS = 272_000;

/** `us.openai.gpt-5.6-luna` → { key: 'gpt-5.6-luna', inference: 'us' }; `openai.gpt-5.6-sol` → in_region. null si el id no es de OpenAI en Bedrock. */
export function parseBedrockModel(model: string): { key: string; inference: ModelPrice['inference'] } | null {
  const match = model.trim().toLowerCase().match(/^(?:(us|global)\.)?openai\.(.+)$/);
  if (!match) return null;
  return { key: match[2], inference: (match[1] as 'us' | 'global' | undefined) ?? 'in_region' };
}

/** Tarifa vigente del modelo para ese tamaño de entrada, o null si no hay (modelo sin tarifa cargada). */
export async function findPrice(db: Queryable, model: string, promptTokens: number): Promise<ModelPrice | null> {
  const parsed = parseBedrockModel(model);
  if (!parsed) return null;
  const tier = promptTokens > LONG_CONTEXT_THRESHOLD_TOKENS ? 'long' : 'short';
  const { rows } = await db.query(
    `SELECT id, model_key, inference, context_tier, input_per_mtok, cache_write_per_mtok, cache_read_per_mtok, output_per_mtok
     FROM model_prices
     WHERE model_key = $1 AND inference = $2 AND context_tier = $3 AND effective_from <= now()
     ORDER BY effective_from DESC LIMIT 1`,
    [parsed.key, parsed.inference, tier],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    modelKey: r.model_key,
    inference: r.inference,
    contextTier: r.context_tier,
    inputPerMtok: Number(r.input_per_mtok),
    cacheWritePerMtok: Number(r.cache_write_per_mtok),
    cacheReadPerMtok: Number(r.cache_read_per_mtok),
    outputPerMtok: Number(r.output_per_mtok),
  };
}

/** Costo en USD. `prompt_tokens` incluye los tokens en caché: los de lectura y escritura se cobran a su tarifa y el resto a la de entrada. */
export function computeCostUsd(price: ModelPrice, usage: TokenUsage): number {
  const cached = Math.max(0, usage.cachedTokens ?? 0);
  const written = Math.max(0, usage.cacheWriteTokens ?? 0);
  const fresh = Math.max(0, usage.promptTokens - cached - written);
  return (
    (fresh * price.inputPerMtok + written * price.cacheWritePerMtok + cached * price.cacheReadPerMtok + usage.completionTokens * price.outputPerMtok) /
    1_000_000
  );
}

/** Cota superior del costo de una llamada: toda la entrada sin caché y la salida al máximo permitido. */
export async function estimateMaxCostUsd(db: Queryable, model: string, inputTokens: number, maxOutputTokens: number): Promise<number | null> {
  const price = await findPrice(db, model, inputTokens);
  if (!price) return null;
  return computeCostUsd(price, { promptTokens: inputTokens, completionTokens: maxOutputTokens });
}

/** Gasto del mes en curso (UTC) de todas las llamadas con tarifa conocida. */
export async function getMonthSpendUsd(db: Queryable): Promise<number> {
  const { rows } = await db.query(`SELECT COALESCE(sum(cost_usd), 0) AS total FROM llm_invocations WHERE created_at >= date_trunc('month', now())`);
  return Number(rows[0].total);
}

export interface SpendBreakdownRow {
  model: string;
  purpose: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  unpricedCalls: number;
}

export async function getMonthBreakdown(db: Queryable): Promise<SpendBreakdownRow[]> {
  const { rows } = await db.query(
    `SELECT model, purpose, count(*)::int AS calls, COALESCE(sum(prompt_tokens), 0)::bigint AS prompt_tokens,
            COALESCE(sum(completion_tokens), 0)::bigint AS completion_tokens, COALESCE(sum(cost_usd), 0) AS cost_usd,
            count(*) FILTER (WHERE cost_usd IS NULL)::int AS unpriced
     FROM llm_invocations WHERE created_at >= date_trunc('month', now())
     GROUP BY model, purpose ORDER BY cost_usd DESC, calls DESC`,
  );
  return rows.map((r) => ({
    model: r.model,
    purpose: r.purpose,
    calls: r.calls,
    promptTokens: Number(r.prompt_tokens),
    completionTokens: Number(r.completion_tokens),
    costUsd: Number(r.cost_usd),
    unpricedCalls: r.unpriced,
  }));
}

export interface InvocationRecord {
  organizationId: string;
  reviewRunId?: string | null;
  repositoryId?: string | null;
  purpose: string;
  method?: string | null;
  providerId?: string | null;
  providerName?: string | null;
  model: string;
  usage: TokenUsage & { reasoningTokens?: number };
  latencyMs?: number | null;
  ok: boolean;
  error?: string | null;
}

/** Guarda una llamada con su costo calculado con la tarifa vigente. Es información auxiliar para el presupuesto: un fallo aquí
 * nunca debe romper el análisis, así que no lanza. `db` debe tener el contexto de la organización (RLS). */
export async function recordInvocation(db: Queryable, rec: InvocationRecord): Promise<number | null> {
  try {
    const price = rec.ok ? await findPrice(db, rec.model, rec.usage.promptTokens) : null;
    const cost = price ? computeCostUsd(price, rec.usage) : null;
    await db.query(
      `INSERT INTO llm_invocations
         (organization_id, review_run_id, repository_id, purpose, method, provider_id, provider_name, model, prompt_tokens, completion_tokens,
          cached_tokens, cache_write_tokens, reasoning_tokens, cost_usd, price_id, latency_ms, ok, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        rec.organizationId, rec.reviewRunId ?? null, rec.repositoryId ?? null, rec.purpose, rec.method ?? null, rec.providerId ?? null, rec.providerName ?? null,
        rec.model, rec.usage.promptTokens, rec.usage.completionTokens, rec.usage.cachedTokens ?? 0, rec.usage.cacheWriteTokens ?? 0,
        rec.usage.reasoningTokens ?? 0, cost, price?.id ?? null, rec.latencyMs ?? null, rec.ok, rec.error ? rec.error.slice(0, 500) : null,
      ],
    );
    return cost;
  } catch {
    return null;
  }
}

/** Gasto de UNA auditoría (todas las capas). */
export async function getRunSpendUsd(db: Queryable, reviewRunId: string): Promise<number> {
  const { rows } = await db.query(`SELECT COALESCE(sum(cost_usd), 0) AS total FROM llm_invocations WHERE review_run_id = $1`, [reviewRunId]);
  return Number(rows[0].total);
}
