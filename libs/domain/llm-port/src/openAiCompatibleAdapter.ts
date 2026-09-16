import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ZodSchema } from 'zod';
import {
  issueReplySuggestionResultSchema,
  reconsiderFindingResultSchema,
  reviewResultSchema,
  type IssueReplySuggestionInput,
  type IssueReplySuggestionResult,
  type ReconsiderFindingInput,
  type ReconsiderFindingResult,
  type ReviewDiffInput,
  type ReviewResult,
} from './types';
import { buildIssueReplySuggestionPrompt, buildReconsiderFindingPrompt, buildSinglePassReviewPrompt } from './prompt';
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

  constructor(
    private readonly model: string,
    baseURL: string,
    apiKey: string,
    private readonly embeddingFn: (text: string) => Promise<number[]>,
  ) {
    this.client = new OpenAI({ baseURL, apiKey });
  }

  async reviewDiff(input: ReviewDiffInput): Promise<ReviewResult> {
    const messages = buildSinglePassReviewPrompt(input);
    return this.requestStructured(messages, reviewResultSchema);
  }

  async reconsiderFinding(input: ReconsiderFindingInput): Promise<ReconsiderFindingResult> {
    const messages = buildReconsiderFindingPrompt(input);
    return this.requestStructured(messages, reconsiderFindingResultSchema);
  }

  async suggestIssueReply(input: IssueReplySuggestionInput): Promise<IssueReplySuggestionResult> {
    const messages = buildIssueReplySuggestionPrompt(input);
    return this.requestStructured(messages, issueReplySuggestionResultSchema);
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
        temperature: 0.1,
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
