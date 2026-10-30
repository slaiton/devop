import { getPool } from '@devsentinel/database';
import { recordInvocation } from '@devsentinel/settings';

export interface UsageEvent {
  method: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  ms: number;
  ok: boolean;
  error?: string;
  providerId: string;
  provider: string;
}

export interface PurposeTotals {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  /** Llamadas sin tarifa cargada: no se pueden contabilizar ni limitar por presupuesto. */
  unpriced: number;
}

/** Recoge el consumo de las llamadas al modelo de UNA revisión: las guarda en `llm_invocations` (con su costo según la tarifa
 * vigente) y acumula totales por propósito para el resumen. `flush()` espera a que se hayan escrito. Es información auxiliar:
 * un fallo al registrar nunca rompe el análisis. */
export class UsageSink {
  private readonly pending: Promise<unknown>[] = [];
  private readonly totals = new Map<string, PurposeTotals>();

  constructor(
    private readonly scope: { organizationId: string; reviewRunId?: string | null; repositoryId?: string | null },
  ) {}

  /** Función para pasar como `onUsage` del enrutador de agentes, atribuyendo el consumo a `purpose` (review, layer2, layer3…). */
  handler(purpose: string): (u: UsageEvent) => void {
    return (u) => {
      const totals = this.totals.get(purpose) ?? { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, unpriced: 0 };
      totals.calls += 1;
      totals.promptTokens += u.promptTokens;
      totals.completionTokens += u.completionTokens;
      this.totals.set(purpose, totals);
      const write = Promise.resolve(
        recordInvocation(getPool(), {
          organizationId: this.scope.organizationId,
          reviewRunId: this.scope.reviewRunId,
          repositoryId: this.scope.repositoryId,
          purpose,
          method: u.method,
          providerId: u.providerId,
          providerName: u.provider,
          model: u.model,
          usage: {
            promptTokens: u.promptTokens,
            completionTokens: u.completionTokens,
            cachedTokens: u.cachedTokens,
            cacheWriteTokens: u.cacheWriteTokens,
            reasoningTokens: u.reasoningTokens,
          },
          latencyMs: u.ms,
          ok: u.ok,
          error: u.error,
        }),
      )
        .then((cost) => {
          if (u.ok && cost === null) totals.unpriced += 1;
          else if (cost !== null) totals.costUsd += cost;
        })
        .catch(() => undefined);
      this.pending.push(write);
    };
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.pending);
  }

  totalsFor(purpose: string): PurposeTotals {
    return this.totals.get(purpose) ?? { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, unpriced: 0 };
  }
}
