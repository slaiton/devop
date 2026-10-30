import { BadRequestException, Injectable } from '@nestjs/common';
import { getPool } from '@devsentinel/database';
import { getAuditBudget, getMonthBreakdown, getMonthSpendUsd, setAuditBudget, type BudgetPolicy } from '@devsentinel/settings';

export interface AuditBudgetInput {
  monthlyUsd?: unknown;
  perAuditUsd?: unknown;
  policy?: unknown;
}

const MAX_USD = 1_000_000;

function usd(raw: unknown, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = typeof raw === 'string' ? Number(raw.replace(',', '.')) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > MAX_USD) {
    throw new BadRequestException(`${label} debe ser un monto en USD entre 0 y ${MAX_USD}`);
  }
  return Math.round(n * 100) / 100;
}

/** Presupuesto de IA del despliegue (una sola cuenta de AWS para todas las organizaciones) y lo gastado en el mes. */
@Injectable()
export class AuditBudgetService {
  async get() {
    const pool = getPool();
    const [budget, spent, breakdown, prices] = await Promise.all([
      getAuditBudget(pool),
      getMonthSpendUsd(pool),
      getMonthBreakdown(pool),
      pool.query(
        `SELECT DISTINCT ON (model_key, inference, context_tier) model_key, inference, context_tier, input_per_mtok, cache_write_per_mtok,
                cache_read_per_mtok, output_per_mtok, source, effective_from
         FROM model_prices WHERE effective_from <= now() ORDER BY model_key, inference, context_tier, effective_from DESC`,
      ),
    ]);
    return {
      budget,
      month: {
        spentUsd: spent,
        remainingUsd: Math.max(0, budget.monthlyUsd - spent),
        percentUsed: budget.monthlyUsd > 0 ? Math.min(100, Math.round((spent / budget.monthlyUsd) * 100)) : 100,
        breakdown,
        unpricedCalls: breakdown.reduce((n, r) => n + r.unpricedCalls, 0),
      },
      prices: prices.rows,
    };
  }

  async set(input: AuditBudgetInput) {
    const monthlyUsd = usd(input.monthlyUsd, 'monthlyUsd');
    const perAuditUsd = usd(input.perAuditUsd, 'perAuditUsd');
    if (input.policy !== undefined && input.policy !== 'partial' && input.policy !== 'block') {
      throw new BadRequestException('policy debe ser "partial" o "block"');
    }
    await setAuditBudget(getPool(), { monthlyUsd, perAuditUsd, policy: input.policy as BudgetPolicy | undefined });
    return this.get();
  }
}
