import { getPool } from '@devsentinel/database';
import { DEFAULT_CONTEXT_WINDOW_TOKENS, DEFAULT_RESERVED_OUTPUT_TOKENS, contextLimitsOf, effectiveInputLimit, LlmContextOverflowError } from '@devsentinel/llm-port';
import { listLlmProviders } from '@devsentinel/settings';

/** Presupuesto de contexto POR CAPA. Cada capa tiene un tope propio (qué se le quiere mandar) y, además, el que impone la ventana REAL de
 * sus agentes (menos lo reservado para la respuesta, con margen) o lo que un rechazo previo del proveedor haya enseñado. Gana el menor:
 *   - revisión general: lo que cabe de la revisión completa (LLM_MAX_INPUT_TOKENS, 150000),
 *   - capa 2 (triaje): lo que cabe en CADA llamada de un fragmento (AUDIT_L2_MAX_INPUT_TOKENS, 100000),
 *   - capa 3 (auditoría avanzada): recibe un RESUMEN, no el código completo (AUDIT_L3_MAX_INPUT_TOKENS, 60000). */
export type BudgetLayer = 'general' | 'layer2' | 'layer3';

export const LAYER_INPUT_CAPS: Record<BudgetLayer, number> = {
  general: Number(process.env.LLM_MAX_INPUT_TOKENS) || 150_000,
  layer2: Number(process.env.AUDIT_L2_MAX_INPUT_TOKENS) || 100_000,
  layer3: Number(process.env.AUDIT_L3_MAX_INPUT_TOKENS) || 60_000,
};

export interface LayerBudget {
  layer: BudgetLayer;
  /** Tokens de entrada que se pueden enviar en UNA llamada a esa capa. */
  inputTokens: number;
  /** Modelo que fija el límite (el más estricto de los agentes de la capa). */
  limitingModel: string | null;
  /** Por qué ese valor: el tope de la capa, la ventana del agente o un límite aprendido. */
  reason: 'layer_cap' | 'model_window' | 'learned_limit';
  models: string[];
}

/** Calcula el presupuesto de entrada de una capa con los agentes configurados AHORA (cambiar la ventana de un agente aplica al siguiente
 * análisis). Los agentes de una capa se usan con respaldo entre ellos: el presupuesto es el del más estricto, así lo que se arme cabe en
 * cualquiera que atienda la llamada. */
export async function inputBudgetFor(layer: BudgetLayer, options: { cap?: number } = {}): Promise<LayerBudget> {
  const pool = getPool();
  let providers = await listLlmProviders(pool, { onlyEnabled: true, layer });
  if (layer === 'general' && providers.length === 0) providers = await listLlmProviders(pool, { onlyEnabled: true });
  const cap = options.cap ?? LAYER_INPUT_CAPS[layer];

  let best: LayerBudget = { layer, inputTokens: cap, limitingModel: null, reason: 'layer_cap', models: providers.map((p) => p.model) };
  for (const p of providers) {
    const limits = contextLimitsOf(p);
    const limit = effectiveInputLimit(p.model, limits) ?? Math.floor((DEFAULT_CONTEXT_WINDOW_TOKENS - DEFAULT_RESERVED_OUTPUT_TOKENS) * 0.92);
    if (limit < best.inputTokens) {
      const byWindow = Math.floor((limits.windowTokens - limits.reservedOutputTokens) * 0.92);
      best = { ...best, inputTokens: limit, limitingModel: p.model, reason: limit < byWindow ? 'learned_limit' : 'model_window' };
    }
  }
  return best;
}

/** Reintento inteligente: ejecuta `attempt` con presupuestos cada vez MENORES (1, 1/2, 1/4…) mientras el proveedor (o la comprobación previa)
 * diga que la entrada no cabe. Nunca repite la misma solicitud: cada intento recibe una escala estrictamente menor. Cualquier otro error se
 * propaga tal cual. */
export async function withContextRetry<T>(
  attempt: (scale: number, attemptNumber: number) => Promise<T>,
  options: { scales?: number[]; onRetry?: (nextScale: number, err: LlmContextOverflowError) => void } = {},
): Promise<T> {
  const scales = options.scales ?? [1, 0.5, 0.25];
  let lastError: LlmContextOverflowError | null = null;
  for (let i = 0; i < scales.length; i++) {
    try {
      return await attempt(scales[i], i + 1);
    } catch (err) {
      if (!(err instanceof LlmContextOverflowError)) throw err;
      lastError = err;
      if (i < scales.length - 1) options.onRetry?.(scales[i + 1], err);
    }
  }
  throw lastError ?? new LlmContextOverflowError('la entrada no cabe');
}
