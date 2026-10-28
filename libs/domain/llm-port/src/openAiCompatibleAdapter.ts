import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ZodSchema } from 'zod';
import {
  AgenticReviewUnsupportedError,
  clarificationResultSchema,
  issueReplySuggestionResultSchema,
  projectProfileExtractionSchema,
  reconsiderFindingResultSchema,
  reviewResultSchema,
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
  type ReconsiderFindingResult,
  type ReviewDiffInput,
  type ReviewResult,
} from './types';
import {
  buildAgenticReviewPrompt,
  buildResolveClarificationPrompt,
  buildExtractProjectProfilePrompt,
  buildIssueReplySuggestionPrompt,
  buildReconsiderFindingPrompt,
  buildSinglePassReviewPrompt,
} from './prompt';
import type { LlmPort } from './llmPort';

/**
 * Implementa LlmPort contra cualquier proveedor compatible con la API de OpenAI
 * (Together.ai por defecto en el MVP - ver docs/architecture/08-mvp-fase0-stack.md).
 * Cambiar de proveedor o modelo es configuración (baseURL/apiKey/model), no código.
 */
function truncate(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export class OpenAiCompatibleLlmAdapter implements LlmPort {
  private readonly client: OpenAI;
  private readonly temperature: number | null;

  constructor(
    private readonly model: string,
    baseURL: string,
    apiKey: string,
    private readonly embeddingFn: (text: string) => Promise<number[]>,
    options: { temperature?: number | null } = {},
  ) {
    this.client = new OpenAI({ baseURL, apiKey });
    // null = no enviar el parámetro (los modelos de razonamiento de OpenAI solo aceptan el valor por defecto)
    this.temperature = options.temperature === undefined ? 0.1 : options.temperature;
  }

  async reviewDiff(input: ReviewDiffInput): Promise<ReviewResult> {
    const messages = buildSinglePassReviewPrompt(input);
    return this.requestStructured(messages, reviewResultSchema);
  }

  /** Revisión con investigación: el modelo puede pedir herramientas de solo lectura (leer archivos,
   * buscar, historial…) en varias rondas antes de emitir el mismo JSON de veredicto de `reviewDiff`.
   * Si el proveedor no acepta herramientas en la primera ronda, lanza `AgenticReviewUnsupportedError`
   * para que el llamador use el análisis estándar. */
  async reviewDiffAgentic(input: ReviewDiffInput, toolbox: AgentToolbox, options: AgenticReviewOptions): Promise<AgenticReviewOutcome> {
    const { value, trace, stats } = await this.runAgentLoop(buildAgenticReviewPrompt(input), toolbox, options, reviewResultSchema);
    return { result: value, trace, stats };
  }

  async resolveClarification(input: ResolveClarificationInput): Promise<ClarificationResult> {
    return this.requestStructured(buildResolveClarificationPrompt(input, false), clarificationResultSchema);
  }

  /** Re-evalúa una pregunta con la respuesta del desarrollador, pudiendo verificar otros repos con herramientas. */
  async resolveClarificationAgentic(
    input: ResolveClarificationInput,
    toolbox: AgentToolbox,
    options: AgenticReviewOptions,
  ): Promise<{ result: ClarificationResult; trace: ToolTraceEntry[]; stats: AgenticReviewStats }> {
    const { value, trace, stats } = await this.runAgentLoop(buildResolveClarificationPrompt(input, true), toolbox, options, clarificationResultSchema);
    return { result: value, trace, stats };
  }

  /** Bucle de investigación común: el modelo pide herramientas de solo lectura en varias rondas y termina con un JSON que
   * cumple `schema`. Está acotado (rondas, consultas, caracteres devueltos, tiempo): si se agota, se le pide el veredicto
   * con lo reunido hasta ahí. Si el proveedor no acepta herramientas en la primera ronda, lanza
   * `AgenticReviewUnsupportedError` para que el llamador use la versión sin herramientas. */
  private async runAgentLoop<T>(
    initialMessages: ChatCompletionMessageParam[],
    toolbox: AgentToolbox,
    options: AgenticReviewOptions,
    schema: ZodSchema<T>,
  ): Promise<{ value: T; trace: ToolTraceEntry[]; stats: AgenticReviewStats }> {
    const startedAt = Date.now();
    const messages: ChatCompletionMessageParam[] = [...initialMessages];
    const tools = toolbox.definitions.map((d) => ({
      type: 'function' as const,
      function: { name: d.name, description: d.description, parameters: d.parameters },
    }));
    const trace: ToolTraceEntry[] = [];
    const answers = new Map<string, string>();
    let promptTokens = 0;
    let completionTokens = 0;
    let toolCalls = 0;
    let toolChars = 0;
    let rounds = 0;
    let budgetExhausted = false;

    const outcome = (value: T) => ({
      value,
      trace,
      stats: { rounds, toolCalls, promptTokens, completionTokens, durationMs: Date.now() - startedAt, budgetExhausted },
    });

    while (true) {
      const remainingMs = options.deadlineMs - (Date.now() - startedAt);
      if (rounds >= options.maxRounds || toolCalls >= options.maxToolCalls || toolChars >= options.maxToolChars || remainingMs <= 0) {
        budgetExhausted = true;
        break;
      }
      rounds += 1;

      let completion;
      try {
        completion = await this.client.chat.completions.create(
          { model: this.model, messages, tools, tool_choice: 'auto', ...(this.temperature === null ? {} : { temperature: this.temperature }) },
          { timeout: Math.max(5_000, Math.min(remainingMs, 120_000)) },
        );
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (rounds === 1 && (status === 400 || status === 404 || status === 422)) {
          throw new AgenticReviewUnsupportedError(
            `el proveedor rechazó la petición con herramientas (HTTP ${status}): ${(err as Error).message}`,
          );
        }
        console.error(`[llm-port] fallo en la ronda ${rounds} del análisis profundo (modelo "${this.model}"): ${(err as Error).message}`);
        throw err;
      }
      promptTokens += completion.usage?.prompt_tokens ?? 0;
      completionTokens += completion.usage?.completion_tokens ?? 0;

      const message = completion.choices[0]?.message;
      if (!message) throw new Error('El proveedor de inferencia devolvió una respuesta vacía');
      const calls = message.tool_calls ?? [];

      if (calls.length === 0) {
        // Sin más herramientas: debe ser el veredicto. Si no cumple el esquema, se le pide corregirlo
        // (sin herramientas) con la misma lógica de reintento de las demás llamadas.
        const parsed = parseJsonWith(schema, message.content ?? '');
        if (parsed.ok) return outcome(parsed.value);
        console.warn(`[llm-port] veredicto del análisis profundo no cumplió el esquema, reintentando: ${parsed.error}`);
        messages.push({ role: 'assistant', content: message.content ?? '' });
        messages.push({
          role: 'user',
          content: `Tu respuesta no cumplió el esquema esperado (${parsed.error}). Responde de nuevo SOLO con el JSON válido del veredicto, sin texto adicional.`,
        });
        return outcome(await this.requestStructured(messages, schema));
      }

      messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: calls });
      for (const call of calls) {
        let args: Record<string, unknown> = {};
        let parseError: string | null = null;
        try {
          const parsedArgs = JSON.parse(call.function.arguments || '{}');
          if (parsedArgs && typeof parsedArgs === 'object' && !Array.isArray(parsedArgs)) args = parsedArgs;
          else parseError = 'los argumentos deben ser un objeto JSON';
        } catch {
          parseError = 'los argumentos no son JSON válido';
        }

        const key = `${call.function.name}:${JSON.stringify(args, Object.keys(args).sort())}`;
        const started = Date.now();
        let output: string;
        let summary: string;
        let ok: boolean;
        if (parseError) {
          output = `Error: ${parseError}.`;
          summary = parseError;
          ok = false;
        } else if (toolCalls >= options.maxToolCalls || toolChars >= options.maxToolChars) {
          output = 'Presupuesto de consultas agotado: no se ejecutó. Emite el veredicto final con lo que ya tienes.';
          summary = 'omitida: presupuesto agotado';
          ok = false;
          budgetExhausted = true;
        } else if (answers.has(key)) {
          output = 'Consulta idéntica a una anterior: no se repite para ahorrar presupuesto. Usa el resultado anterior.';
          summary = 'repetida (omitida)';
          ok = false;
        } else {
          toolCalls += 1;
          const result = await toolbox.execute(call.function.name, args);
          output = result.output.slice(0, Math.max(0, options.maxToolChars - toolChars));
          if (output.length < result.output.length) output += '\n[...recortado por el presupuesto de contexto]';
          summary = result.summary;
          ok = result.ok;
          toolChars += output.length;
          answers.set(key, output);
        }
        trace.push({ round: rounds, tool: call.function.name, args, ok, summary, chars: output.length, ms: Date.now() - started });
        messages.push({ role: 'tool', tool_call_id: call.id, content: output });
      }
    }

    messages.push({
      role: 'user',
      content:
        'Se agotó el presupuesto de investigación. Emite AHORA el veredicto final como el JSON del esquema indicado, con la evidencia que reuniste hasta aquí (indica en la justificación qué no alcanzaste a verificar).',
    });
    return outcome(await this.requestStructured(messages, schema));
  }

  async reconsiderFinding(input: ReconsiderFindingInput): Promise<ReconsiderFindingResult> {
    const messages = buildReconsiderFindingPrompt(input);
    return this.requestStructured(messages, reconsiderFindingResultSchema);
  }

  async suggestIssueReply(input: IssueReplySuggestionInput): Promise<IssueReplySuggestionResult> {
    const messages = buildIssueReplySuggestionPrompt(input);
    return this.requestStructured(messages, issueReplySuggestionResultSchema);
  }

  async extractProjectProfile(input: ExtractProjectProfileInput): Promise<ProjectProfileExtraction> {
    const messages = buildExtractProjectProfilePrompt(input);
    return this.requestStructured(messages, projectProfileExtractionSchema);
  }

  async embed(text: string): Promise<number[]> {
    return this.embeddingFn(text);
  }

  /** Pide una respuesta JSON y la valida contra `schema`; los modelos open-source son
   * menos consistentes con JSON estricto que los modelos de frontera cerrados, así que
   * un reintento con el error de validación adjunto resuelve la mayoría de los casos
   * sin intervención humana. Si el reintento también falla, es una señal real de que el
   * modelo/proveedor configurado no está respondiendo correctamente — se deja log. */
  private async requestStructured<T>(messages: ChatCompletionMessageParam[], schema: ZodSchema<T>): Promise<T> {
    const raw = await this.requestCompletion(messages);
    try {
      return schema.parse(JSON.parse(raw));
    } catch (err) {
      console.warn(
        `[llm-port] respuesta de "${this.model}" no cumplió el esquema esperado, reintentando una vez: ${(err as Error).message}`,
      );
      const retryMessages: ChatCompletionMessageParam[] = [
        ...messages,
        { role: 'assistant', content: raw },
        {
          role: 'user',
          content: `Tu respuesta anterior no cumplió el esquema esperado (${(err as Error).message}). Responde de nuevo SOLO con el JSON válido, sin texto adicional.`,
        },
      ];
      const retryRaw = await this.requestCompletion(retryMessages);
      try {
        return schema.parse(JSON.parse(retryRaw));
      } catch (retryErr) {
        console.error(
          `[llm-port] modelo "${this.model}" no devolvió JSON válido tras reintento: ${(retryErr as Error).message}`,
          { firstAttempt: truncate(raw), retryAttempt: truncate(retryRaw) },
        );
        throw retryErr;
      }
    }
  }

  private async requestCompletion(messages: ChatCompletionMessageParam[]): Promise<string> {
    let completion;
    try {
      completion = await this.client.chat.completions.create({
        model: this.model,
        messages,
        response_format: { type: 'json_object' },
        ...(this.temperature === null ? {} : { temperature: this.temperature }),
      });
    } catch (err) {
      console.error(`[llm-port] fallo llamando al proveedor de inferencia (modelo "${this.model}"): ${(err as Error).message}`);
      throw err;
    }
    const content = completion.choices[0]?.message?.content;
    if (!content) {
      console.error(`[llm-port] el proveedor de inferencia devolvió una respuesta vacía (modelo "${this.model}")`);
      throw new Error('El proveedor de inferencia devolvió una respuesta vacía');
    }
    return content;
  }
}

/** El JSON final puede venir dentro de un bloque ```json o con texto alrededor: toma el primer objeto JSON y lo valida. */
function parseJsonWith<T>(schema: ZodSchema<T>, content: string): { ok: true; value: T } | { ok: false; error: string } {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, error: 'no se encontró un objeto JSON' };
  try {
    return { ok: true, value: schema.parse(JSON.parse(content.slice(start, end + 1))) };
  } catch (err) {
    return { ok: false, error: (err as Error).message.slice(0, 400) };
  }
}
