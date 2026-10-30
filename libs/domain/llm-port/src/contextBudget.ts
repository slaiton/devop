import { LlmContextOverflowError } from './types';

/** Gestión del contexto de los modelos: contar tokens ANTES de enviar, reservar espacio para la respuesta, y aprender de lo que cada
 * modelo realmente acepta. No se inventa un tokenizador: las estimaciones parten de una relación conservadora (caracteres por token) que se
 * corrige con el consumo REAL que reporta el proveedor en cada llamada, y el límite efectivo baja solo si un modelo rechaza una entrada. */

/** Los modelos modernos tokenizan el código a ~3 caracteres por token o menos; se parte de eso (conservador). */
export const DEFAULT_CHARS_PER_TOKEN = 3;
const MIN_CHARS_PER_TOKEN = 1.8;
/** Aunque el texto sea prosa (4+ caracteres por token) no se confía en más de esto: preferimos sobreestimar. */
const MAX_CHARS_PER_TOKEN = 3.5;
/** Fracción de (ventana − reserva de salida) que se permite usar: margen para los tokens que el estimador no ve. */
export const WINDOW_SAFETY = 0.92;
/** Tras un rechazo real del proveedor, el límite aprendido queda por debajo de lo que se estimó (no se vuelve a probar lo mismo). */
const LEARNED_CEILING_FACTOR = 0.8;

export interface ChatMessageLike {
  role?: string;
  content?: unknown;
  tool_calls?: { function?: { name?: string; arguments?: string } }[] | null;
}

/** Caracteres que ocupa una conversación (contenido + argumentos de llamadas a herramientas + un pequeño costo fijo por mensaje). */
export function messagesChars(messages: ChatMessageLike[]): number {
  let total = 0;
  for (const m of messages) {
    total += 16;
    if (typeof m.content === 'string') total += m.content.length;
    else if (Array.isArray(m.content)) total += JSON.stringify(m.content).length;
    for (const call of m.tool_calls ?? []) total += (call.function?.name?.length ?? 0) + (call.function?.arguments?.length ?? 0) + 20;
  }
  return total;
}

class TokenEstimator {
  private readonly ratio = new Map<string, number>();
  private readonly ceiling = new Map<string, number>();

  charsPerToken(model: string): number {
    return this.ratio.get(model) ?? DEFAULT_CHARS_PER_TOKEN;
  }

  estimateChars(model: string, chars: number): number {
    return Math.ceil(chars / this.charsPerToken(model));
  }

  estimateMessages(model: string, messages: ChatMessageLike[]): number {
    return this.estimateChars(model, messagesChars(messages));
  }

  /** Corrige la relación caracteres/token con lo que el proveedor cobró de verdad (media móvil, acotada). */
  observe(model: string, chars: number, promptTokens: number): void {
    if (!(promptTokens > 500) || !(chars > 500)) return;
    const observed = Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, chars / promptTokens));
    const current = this.ratio.get(model) ?? DEFAULT_CHARS_PER_TOKEN;
    this.ratio.set(model, current * 0.7 + observed * 0.3);
  }

  /** El proveedor rechazó una entrada estimada en `estimatedTokens`: nada igual o mayor volverá a enviarse a ese modelo. */
  learnOverflow(model: string, estimatedTokens: number): void {
    const next = Math.floor(estimatedTokens * LEARNED_CEILING_FACTOR);
    const prev = this.ceiling.get(model);
    if (prev === undefined || next < prev) this.ceiling.set(model, next);
  }

  learnedCeiling(model: string): number | undefined {
    return this.ceiling.get(model);
  }

  reset(): void {
    this.ratio.clear();
    this.ceiling.clear();
  }
}

export const tokenEstimator = new TokenEstimator();

export interface ContextLimits {
  /** Ventana de contexto del modelo en tokens (entrada + salida). */
  windowTokens: number;
  /** Tokens que se reservan para la respuesta (incluye el razonamiento en los modelos que lo cuentan como salida). */
  reservedOutputTokens: number;
}

/** Tokens de ENTRADA que se pueden enviar: la ventana menos lo reservado para la respuesta, con margen de seguridad. */
export function inputTokenBudget(limits: ContextLimits): number {
  return Math.max(1000, Math.floor((limits.windowTokens - limits.reservedOutputTokens) * WINDOW_SAFETY));
}

/** Límite efectivo de entrada de un modelo: el de su ventana, o el aprendido si un rechazo real lo dejó más abajo. */
export function effectiveInputLimit(model: string, limits: ContextLimits | undefined): number | undefined {
  const byWindow = limits ? inputTokenBudget(limits) : undefined;
  const learned = tokenEstimator.learnedCeiling(model);
  if (byWindow === undefined) return learned;
  return learned === undefined ? byWindow : Math.min(byWindow, learned);
}

/** Comprobación previa: si lo que se va a enviar no cabe, falla ya (sin gastar una llamada que el proveedor rechazaría) para que quien
 * llama reduzca el contenido y reintente. */
export function assertFits(model: string, messages: ChatMessageLike[], limits: ContextLimits | undefined): number {
  const estimated = tokenEstimator.estimateMessages(model, messages);
  const limit = effectiveInputLimit(model, limits);
  if (limit !== undefined && estimated > limit) {
    throw new LlmContextOverflowError(
      `la entrada estimada (~${estimated.toLocaleString('es')} tokens) supera lo que cabe en la ventana del modelo "${model}" (~${limit.toLocaleString('es')} tokens de entrada): comprobación previa, no se envió`,
    );
  }
  return estimated;
}

/** Reduce el contexto de una conversación con herramientas SIN tirar nada de golpe: los resultados de herramientas más antiguos y grandes
 * se reemplazan por un resumen corto (su inicio) hasta que quepa. Devuelve cuántos se comprimieron. */
export function compressToolOutputs(model: string, messages: ChatMessageLike[], limits: ContextLimits | undefined, headChars = 400): number {
  const limit = effectiveInputLimit(model, limits);
  if (limit === undefined) return 0;
  const target = Math.floor(limit * 0.85);
  let compressed = 0;
  for (const m of messages) {
    if (tokenEstimator.estimateMessages(model, messages) <= target) break;
    if (m.role !== 'tool' || typeof m.content !== 'string' || m.content.length <= headChars * 2) continue;
    m.content = `${m.content.slice(0, headChars)}\n[...resultado resumido para ahorrar contexto: eran ${m.content.length.toLocaleString('es')} caracteres]`;
    compressed += 1;
  }
  return compressed;
}
