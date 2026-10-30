import { Injectable, Logger } from '@nestjs/common';
import { getPool } from '@devsentinel/database';
import type { ProjectProfile, RecentCommit, ReviewResult } from '@devsentinel/llm-port';
import { estimateMaxCostUsd, getAuditBudget, getMonthSpendUsd, getRunSpendUsd, type AuditBudget } from '@devsentinel/settings';
import { createLayerRouter, type UsageSink } from '../../../common/llmRouter.factory';
import type { Layer1Result } from '../types';
import { classifyChange, type ChangeTagResult } from './changeProfile';
import { buildTriageContext } from './context';
import { evaluateEscalation, escalationConfigFromEnv, type EscalationResult } from './escalation';
import { validateTriage, type ValidatedTriage } from './validate';

/** ok = corrió y su respuesta se validó; skipped_budget = no corrió por presupuesto; not_configured = no hay agente asignado a la capa 2;
 * failed = el modelo falló o devolvió algo inutilizable. Todo lo que no sea "ok" deja la auditoría INCOMPLETA. */
export type Layer2Status = 'ok' | 'skipped_budget' | 'not_configured' | 'failed';

export interface Layer2Outcome {
  status: Layer2Status;
  reason: string | null;
  model: string | null;
  models: string[];
  /** La revisión completa derivada del triaje (solo si status = ok). */
  reviewResult: ReviewResult | null;
  validated: ValidatedTriage | null;
  escalation: EscalationResult;
  changeTags: ChangeTagResult[];
  /** Resumen del triaje para el revisor avanzado cuando se escala. */
  triageSummary: string;
  usage: { calls: number; promptTokens: number; completionTokens: number; costUsd: number; unpriced: number };
  durationMs: number;
  /** Política de presupuesto vigente cuando se omitió por presupuesto (para aplicarla al veredicto). */
  budgetPolicy: AuditBudget['policy'] | null;
  omittedFindings: number;
  /** Lo decide el flujo de revisión: true si esta capa produjo la revisión final del commit. */
  usedAsReview: boolean;
}

export interface Layer2Params {
  payload: {
    organizationId: string;
    repositoryId: string;
    reviewRunId: string;
    owner: string;
    repo: string;
    commitSha: string;
    branch?: string | null;
    pullNumber?: number | null;
  };
  checkoutPath: string;
  diff: string;
  analyzedFiles: string[];
  layer1: Layer1Result;
  projectProfile?: ProjectProfile;
  recentCommits?: RecentCommit[];
  sink: UsageSink;
}

const MAX_OUTPUT_TOKENS = Number(process.env.AUDIT_L2_MAX_OUTPUT_TOKENS) || 8_000;
/** Estimación conservadora de tokens a partir de caracteres (el código tokeniza peor que la prosa). */
const CHARS_PER_TOKEN = 3;

const emptyUsage = { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, unpriced: 0 };

/** Capa 2 de la auditoría: triaje con un modelo barato (p. ej. GPT-5.6 Luna en Bedrock). Recibe los hallazgos de la capa 1, el diff y
 * contexto de código selectivo; devuelve un informe que la aplicación VALIDA contra el repositorio antes de aceptarlo. No puede
 * aprobar nada ni anular un bloqueo obligatorio. */
@Injectable()
export class Layer2Service {
  private readonly logger = new Logger(Layer2Service.name);

  async run(params: Layer2Params): Promise<Layer2Outcome> {
    const started = Date.now();
    const { payload, layer1, sink } = params;
    const changeTags = classifyChange(params.analyzedFiles);
    const base: Layer2Outcome = {
      status: 'failed',
      reason: null,
      model: null,
      models: [],
      reviewResult: null,
      validated: null,
      escalation: { recommended: false, triggers: [] },
      changeTags,
      triageSummary: '',
      usage: emptyUsage,
      durationMs: 0,
      budgetPolicy: null,
      omittedFindings: 0,
      usedAsReview: false,
    };
    // Antes de cerrar se espera a que el consumo de esta capa esté guardado: el costo del resumen sale de ahí.
    const done = async (patch: Partial<Layer2Outcome>): Promise<Layer2Outcome> => {
      await sink.flush();
      return { ...base, ...patch, usage: { ...sink.totalsFor('layer2') }, durationMs: Date.now() - started };
    };

    const layer = await createLayerRouter(
      'layer2',
      { organizationId: payload.organizationId, reviewRunId: payload.reviewRunId, repositoryId: payload.repositoryId, purpose: 'layer2', sink },
      { reasoningEffort: process.env.AUDIT_L2_REASONING?.trim() || 'low', maxOutputTokens: MAX_OUTPUT_TOKENS },
    );
    if (!layer) {
      return done({ status: 'not_configured', reason: 'No hay ningún agente de IA asignado a la capa 2: asígnalo en Configuración → Agentes de IA.' });
    }
    const models = layer.models;

    const ctx = await buildTriageContext({
      repositoryFullName: `${payload.owner}/${payload.repo}`,
      commitSha: payload.commitSha,
      branch: payload.branch ?? null,
      baseBranch: null,
      pullNumber: payload.pullNumber ?? null,
      checkoutPath: params.checkoutPath,
      diff: params.diff,
      analyzedFiles: params.analyzedFiles,
      layer1,
      projectProfile: params.projectProfile,
      recentCommits: params.recentCommits,
    });
    base.omittedFindings = ctx.omittedFindings;

    // ---- presupuesto: se comprueba ANTES de llamar al modelo, con una cota superior del costo de esta llamada
    const pool = getPool();
    const budget = await getAuditBudget(pool);
    const inputChars = JSON.stringify(ctx.input).length;
    const estimatedTokens = Math.ceil(inputChars / CHARS_PER_TOKEN) + 2_000;
    const estimate = await estimateMaxCostUsd(pool, models[0], estimatedTokens, MAX_OUTPUT_TOKENS);
    if (estimate !== null) {
      const [month, runSpent] = await Promise.all([getMonthSpendUsd(pool), getRunSpendUsd(pool, payload.reviewRunId)]);
      if (month + estimate > budget.monthlyUsd) {
        return done({
          status: 'skipped_budget',
          reason: `Presupuesto mensual de IA agotado: gastado ${month.toFixed(2)} USD de ${budget.monthlyUsd.toFixed(2)} y esta llamada podría costar hasta ${estimate.toFixed(2)} USD.`,
          models,
          budgetPolicy: budget.policy,
        });
      }
      if (runSpent + estimate > budget.perAuditUsd) {
        return done({
          status: 'skipped_budget',
          reason: `Límite por auditoría superado: esta auditoría lleva ${runSpent.toFixed(2)} USD de ${budget.perAuditUsd.toFixed(2)} y la capa 2 podría costar hasta ${estimate.toFixed(2)} USD.`,
          models,
          budgetPolicy: budget.policy,
        });
      }
    } else {
      this.logger.warn(`el modelo "${models[0]}" no tiene tarifa en model_prices: la capa 2 corre sin poder limitar su costo por presupuesto`);
    }

    // ---- llamada al modelo
    let triage;
    try {
      triage = await layer.router.triageAudit(ctx.input);
    } catch (err) {
      const message = (err as Error).message.replace(/\s+/g, ' ').slice(0, 300);
      this.logger.error(`capa 2 falló en ${payload.owner}/${payload.repo}@${payload.commitSha.slice(0, 7)}: ${message}`);
      return done({ status: 'failed', reason: `El modelo de la capa 2 falló: ${message}`, models });
    }
    const answered = layer.router.calls.find((c) => c.ok && c.method === 'triageAudit');

    // ---- validación contra el repositorio real: nada del modelo se acepta tal cual
    const validated = await validateTriage(triage, {
      checkoutPath: params.checkoutPath,
      diffText: ctx.input.diff,
      refMap: ctx.refMap,
      orderedRefs: ctx.input.scannerFindings.map((f) => f.ref),
    });
    const escalation = evaluateEscalation({ triage, validated, changeTags, layer1Findings: layer1.findings, config: escalationConfigFromEnv() });

    const tests = [...new Set([...triage.tests_recomendados, ...triage.findings.flatMap((f) => f.suggested_tests)])].slice(0, 20);
    const notes: string[] = [];
    if (validated.rejected.length) notes.push(`${validated.rejected.length} hallazgo(s) del modelo se descartaron por no poder comprobarse en el repositorio.`);
    if (validated.dismissals.accepted.length) notes.push(`${validated.dismissals.accepted.length} hallazgo(s) de los escáneres se marcaron como posible falso positivo.`);
    const reviewResult: ReviewResult = {
      resultado: triage.resultado,
      findings: validated.findings,
      quality_score: triage.quality_score,
      risk_level: triage.risk_level,
      resumen_ejecutivo: [triage.resumen_ejecutivo, ...notes].join('\n\n'),
      recomendaciones: triage.recomendaciones,
      tests_recomendados: tests,
      comparacion_commits_previos: triage.comparacion_commits_previos,
      justificacion_final: triage.justificacion_final,
    };

    const triageSummary = [
      `Triaje de la capa 2 (${answered?.model ?? models[0]}):`,
      ...validated.groups.map((g) => `- Grupo "${g.title}" (${g.refs.join(', ')}): ${g.rationale}`),
      ...validated.dismissals.accepted.map((d) => `- Posible falso positivo ${d.ref}: ${d.reason}`),
      ...escalation.triggers.map((t) => `- Motivo de escalamiento (${t.type}): ${t.detail}`),
    ].join('\n');

    return done({
      status: 'ok',
      reason: null,
      model: answered?.model ?? models[0],
      models,
      reviewResult,
      validated,
      escalation,
      triageSummary,
    });
  }
}
