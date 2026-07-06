import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { reviewResultSchema, type ReviewDiffInput, type ReviewResult } from './types';
import { buildSinglePassReviewPrompt } from './prompt';
import type { LlmPort } from './llmPort';

/**
 * Implementa LlmPort contra cualquier proveedor compatible con la API de OpenAI
 * (Together.ai por defecto en el MVP - ver docs/architecture/08-mvp-fase0-stack.md).
 * Cambiar de proveedor o modelo es configuración (baseURL/apiKey/model), no código.
 */
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
    const raw = await this.requestCompletion(messages);

    try {
      return reviewResultSchema.parse(JSON.parse(raw));
    } catch (err) {
      // Los modelos open-source son menos consistentes con JSON estricto que los
      // modelos de frontera cerrados: un reintento con el error de validación
      // adjunto resuelve la mayoría de los casos sin intervención humana.
      const retryMessages: ChatCompletionMessageParam[] = [
        ...messages,
        { role: 'assistant', content: raw },
        {
          role: 'user',
          content: `Tu respuesta anterior no cumplió el esquema esperado (${(err as Error).message}). Responde de nuevo SOLO con el JSON válido, sin texto adicional.`,
        },
      ];
      const retryRaw = await this.requestCompletion(retryMessages);
      return reviewResultSchema.parse(JSON.parse(retryRaw));
    }
  }

  async embed(text: string): Promise<number[]> {
    return this.embeddingFn(text);
  }

  private async requestCompletion(messages: ChatCompletionMessageParam[]): Promise<string> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages,
      response_format: { type: 'json_object' },
      temperature: 0.1,
    });
    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new Error('El proveedor de inferencia devolvió una respuesta vacía');
    }
    return content;
  }
}
