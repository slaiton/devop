import { createHash } from 'crypto';
import type { LlmPort } from './llmPort';
import { OpenAiCompatibleLlmAdapter } from './openAiCompatibleAdapter';
import { embedLocally } from './localEmbeddings';
import {
  AgenticReviewUnsupportedError,
  LlmContextOverflowError,
  type AgentToolbox,
  type AgenticReviewOptions,
  type AgenticReviewOutcome,
  type AgenticReviewStats,
  type ClarificationResult,
  type ResolveClarificationInput,
  type ToolTraceEntry,
  type ExtractProjectProfileInput,
  type IssueReplySuggestionInput,
  type IssueReplySuggestionResult,
  type ProjectProfileExtraction,
  type ReconsiderFindingInput,
  type LlmUsageRecord,
  type ReconsiderFindingResult,
  type ReviewDiffInput,
  type ReviewResult,
} from './types';

import type { TriageInput, TriageResult } from './triage';

export type LlmRoutingMode = 'failover' | 'round_robin';

/** Un agente listo para usarse: el id y el nombre salen de la configuración; `llm` hace las llamadas. */
export interface RoutedProvider {
  id: string;
  name: string;
  model: string;
  llm: LlmPort;
  /** Clave de la pausa por falla. Cambia si se edita la URL, el modelo o la clave del agente, así corregirlo lo "despausa". Por defecto, el id. */
  cooldownKey?: string;
}

/** Qué pasó en cada intento (sirve para saber qué agente respondió y cuáles fallaron antes). */
export interface LlmCallRecord {
  method: string;
  providerId: string;
  provider: string;
  model: string;
  ok: boolean;
  error?: string;
  /** El agente no soporta herramientas: no es una falla del servicio, no lo penaliza. */
  unsupported?: boolean;
  /** La entrada no cabe en la ventana de contexto del modelo: culpa del tamaño de lo enviado, no del agente; no lo penaliza. */
  inputTooLarge?: boolean;
  ms: number;
}

export interface LlmRouterOptions {
  mode: LlmRoutingMode;
  /** Turno del modo round_robin (número creciente compartido entre procesos): decide con quién empieza. */
  turn?: number;
  /** Tras una falla, el agente se deja de lado este tiempo (sigue de último recurso). */
  cooldownMs?: number;
  now?: () => number;
  /** Se invoca en cada intento; los errores de este callback se ignoran. */
  onAttempt?: (record: LlmCallRecord) => void | Promise<void>;
  /** Estado de "enfriamiento" por agente. Por defecto uno compartido por todo el proceso. */
  cooldowns?: Map<string, number>;
  /** Consumo de cada llamada (tokens, latencia) con el agente que la atendió; para costos y presupuesto. */
  onUsage?: (usage: LlmUsageRecord & { providerId: string; provider: string }) => void;
  /** Capa 2 de la auditoría: esfuerzo de razonamiento y tope de tokens de salida. */
  triage?: { reasoningEffort?: string; maxOutputTokens?: number };
}

export class LlmNotConfiguredError extends Error {
  constructor() {
    super('No hay ningún agente de IA activo configurado: agrégalo en Configuración → Agentes de IA.');
    this.name = 'LlmNotConfiguredError';
  }
}

export class LlmAllProvidersFailedError extends Error {
  constructor(
    method: string,
    readonly failures: { provider: string; error: string }[],
  ) {
    super(`Fallaron todos los agentes de IA (${method}): ${failures.map((f) => `${f.provider}: ${f.error}`).join(' | ')}`);
    this.name = 'LlmAllProvidersFailedError';
  }
}

const DEFAULT_COOLDOWN_MS = 120_000;
const REVIEW_METHODS = ['reviewDiff', 'reviewDiffAgentic'];
const sharedCooldowns = new Map<string, number>();

/** Olvida todas las pausas por falla (para pruebas y operación). */
export function clearLlmCooldowns(): void {
  sharedCooldowns.clear();
}

const short = (err: unknown): string => {
  const e = err as { status?: number; message?: string };
  const text = (e?.message ?? String(err)).replace(/\s+/g, ' ').trim();
  return (e?.status && !text.startsWith(String(e.status)) ? `HTTP ${e.status}: ${text}` : text).slice(0, 240);
};

/**
 * Reparte las llamadas al LLM entre varios agentes:
 *  - `failover`: siempre empieza por el primero (en el orden configurado); si falla, pasa al siguiente.
 *  - `round_robin`: empieza por el que toca según el turno (se intercalan); si falla, sigue con los
 *    demás en el orden de la rotación.
 * Un agente que acaba de fallar queda en pausa unos minutos para no gastar cada análisis en
 * reintentar uno caído; si todos están en pausa se prueban igual (de último recurso).
 * Una instancia vive lo que dura un análisis: todos sus pasos parten del mismo orden.
 */
export class LlmRouter implements LlmPort {
  readonly calls: LlmCallRecord[] = [];
  private readonly cooldowns: Map<string, number>;
  private readonly now: () => number;
  private readonly cooldownMs: number;

  constructor(
    private readonly providers: RoutedProvider[],
    private readonly options: LlmRouterOptions,
  ) {
    this.cooldowns = options.cooldowns ?? sharedCooldowns;
    this.now = options.now ?? Date.now;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  }

  private keyOf(p: RoutedProvider): string {
    return p.cooldownKey ?? p.id;
  }

  /** Orden en que se intentarán los agentes en esta instancia. */
  order(): RoutedProvider[] {
    let list = [...this.providers];
    if (this.options.mode === 'round_robin' && list.length > 1) {
      const start = ((Math.trunc(this.options.turn ?? 0) % list.length) + list.length) % list.length;
      list = [...list.slice(start), ...list.slice(0, start)];
    }
    const now = this.now();
    const paused = (p: RoutedProvider) => (this.cooldowns.get(this.keyOf(p)) ?? 0) > now;
    return [...list.filter((p) => !paused(p)), ...list.filter(paused)];
  }

  /** Agente que respondió la revisión y los que fallaron antes (para dejarlo en la revisión). */
  reviewUsage(): { provider: string | null; model: string | null; failovers: { provider: string; model: string; error: string }[] } {
    const reviewCalls = this.calls.filter((c) => REVIEW_METHODS.includes(c.method));
    const answered = [...reviewCalls].reverse().find((c) => c.ok);
    return {
      provider: answered?.provider ?? null,
      model: answered?.model ?? null,
      failovers: reviewCalls.filter((c) => !c.ok).map((c) => ({ provider: c.provider, model: c.model, error: c.error ?? 'error' })),
    };
  }

  private async run<T>(method: string, call: (llm: LlmPort) => Promise<T>): Promise<T> {
    if (this.providers.length === 0) throw new LlmNotConfiguredError();
    const failures: { provider: string; error: string }[] = [];
    let onlyUnsupported = true;
    let onlyOverflow = true;

    for (const p of this.order()) {
      const started = this.now();
      try {
        const result = await call(p.llm);
        this.cooldowns.delete(this.keyOf(p));
        await this.record({ method, providerId: p.id, provider: p.name, model: p.model, ok: true, ms: this.now() - started });
        return result;
      } catch (err) {
        const unsupported = err instanceof AgenticReviewUnsupportedError;
        const inputTooLarge = err instanceof LlmContextOverflowError;
        if (!unsupported) onlyUnsupported = false;
        if (!inputTooLarge) onlyOverflow = false;
        // Ni "no soporta herramientas" ni "la entrada no cabe" son fallas del agente: no se pausa.
        if (!unsupported && !inputTooLarge) this.cooldowns.set(this.keyOf(p), this.now() + this.cooldownMs);
        const error = unsupported ? 'no soporta herramientas (function calling)' : inputTooLarge ? 'la entrada supera la ventana de contexto del modelo' : short(err);
        failures.push({ provider: p.name, error });
        await this.record({ method, providerId: p.id, provider: p.name, model: p.model, ok: false, error, unsupported, inputTooLarge, ms: this.now() - started });
      }
    }
    // Si NINGÚN agente pudo con el tamaño, el llamador debe reducir la entrada y reintentar (no es una caída de los agentes).
    if (onlyOverflow && failures.length > 0) {
      throw new LlmContextOverflowError(`la entrada no cabe en la ventana de contexto de ningún agente: ${failures.map((f) => f.provider).join(', ')}`);
    }
    if (onlyUnsupported) {
      throw new AgenticReviewUnsupportedError(`ningún agente activo soporta herramientas: ${failures.map((f) => f.provider).join(', ')}`);
    }
    throw new LlmAllProvidersFailedError(method, failures);
  }

  private async record(entry: LlmCallRecord): Promise<void> {
    this.calls.push(entry);
    try {
      await this.options.onAttempt?.(entry);
    } catch {
      // el registro es auxiliar: nunca debe romper el análisis
    }
  }

  reviewDiff(input: ReviewDiffInput): Promise<ReviewResult> {
    return this.run('reviewDiff', (l) => l.reviewDiff(input));
  }

  reviewDiffAgentic(input: ReviewDiffInput, toolbox: AgentToolbox, options: AgenticReviewOptions): Promise<AgenticReviewOutcome> {
    return this.run('reviewDiffAgentic', (l) => l.reviewDiffAgentic(input, toolbox, options));
  }

  resolveClarification(input: ResolveClarificationInput): Promise<ClarificationResult> {
    return this.run('resolveClarification', (l) => l.resolveClarification(input));
  }

  resolveClarificationAgentic(
    input: ResolveClarificationInput,
    toolbox: AgentToolbox,
    options: AgenticReviewOptions,
  ): Promise<{ result: ClarificationResult; trace: ToolTraceEntry[]; stats: AgenticReviewStats }> {
    return this.run('resolveClarificationAgentic', (l) => l.resolveClarificationAgentic(input, toolbox, options));
  }

  triageAudit(input: TriageInput): Promise<TriageResult> {
    return this.run('triageAudit', (l) => l.triageAudit(input));
  }

  reconsiderFinding(input: ReconsiderFindingInput): Promise<ReconsiderFindingResult> {
    return this.run('reconsiderFinding', (l) => l.reconsiderFinding(input));
  }

  suggestIssueReply(input: IssueReplySuggestionInput): Promise<IssueReplySuggestionResult> {
    return this.run('suggestIssueReply', (l) => l.suggestIssueReply(input));
  }

  extractProjectProfile(input: ExtractProjectProfileInput): Promise<ProjectProfileExtraction> {
    return this.run('extractProjectProfile', (l) => l.extractProjectProfile(input));
  }

  /** Los embeddings son locales (no dependen de ningún agente). */
  embed(text: string): Promise<number[]> {
    return embedLocally(text);
  }
}

export interface ProviderConfigLike {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  /** Ventana de contexto del modelo (tokens). Sin dato se usa LLM_DEFAULT_CONTEXT_TOKENS (272000). */
  contextWindowTokens?: number | null;
  /** Tokens que se reservan para la respuesta. Sin dato se usa LLM_DEFAULT_OUTPUT_TOKENS (16000). */
  maxOutputTokens?: number | null;
}

export const DEFAULT_CONTEXT_WINDOW_TOKENS = Number(process.env.LLM_DEFAULT_CONTEXT_TOKENS) || 272_000;
export const DEFAULT_RESERVED_OUTPUT_TOKENS = Number(process.env.LLM_DEFAULT_OUTPUT_TOKENS) || 16_000;

/** Límites de contexto de un agente (con los valores por defecto cuando no se configuraron). */
export function contextLimitsOf(config: Pick<ProviderConfigLike, 'contextWindowTokens' | 'maxOutputTokens'>): { windowTokens: number; reservedOutputTokens: number } {
  return {
    windowTokens: config.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
    reservedOutputTokens: config.maxOutputTokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS,
  };
}

/** Los modelos de razonamiento de OpenAI (o1/o3/o4, gpt-5…) solo aceptan la temperatura por defecto. */
export function temperatureFor(kind: string, model: string): number | null {
  // En Bedrock el id lleva prefijos (`global.openai.gpt-5.6-sol`, `us.openai.…`): son modelos de razonamiento.
  if (kind === 'bedrock') return null;
  return kind === 'openai' && /^(o\d|gpt-5)/i.test(model.trim()) ? null : 0.1;
}

export function buildRoutedProvider(config: ProviderConfigLike, routerOptions?: Pick<LlmRouterOptions, 'onUsage' | 'triage'>): RoutedProvider {
  return {
    id: config.id,
    name: config.name,
    model: config.model,
    cooldownKey: `${config.id}:${createHash('sha1').update(`${config.baseUrl}|${config.model}|${config.apiKey ?? ''}`).digest('hex').slice(0, 10)}`,
    llm: new OpenAiCompatibleLlmAdapter(config.model, config.baseUrl, config.apiKey ?? '', embedLocally, {
      temperature: temperatureFor(config.kind, config.model),
      // Bedrock (GPT-5.6 Sol): en /chat/completions las herramientas no se admiten con razonamiento activo
      // ("Function tools with reasoning_effort are not supported… set reasoning_effort to 'none'"). Las rondas de
      // investigación del análisis profundo van sin razonamiento; el análisis estándar conserva el razonamiento por defecto.
      toolReasoningEffort: config.kind === 'bedrock' ? 'none' : undefined,
      onUsage: routerOptions?.onUsage ? (u) => routerOptions.onUsage!({ ...u, providerId: config.id, provider: config.name }) : undefined,
      triage: routerOptions?.triage,
      context: contextLimitsOf(config),
    }),
  };
}

export function buildLlmRouter(configs: ProviderConfigLike[], options: LlmRouterOptions): LlmRouter {
  return new LlmRouter(configs.map((c) => buildRoutedProvider(c, options)), options);
}
