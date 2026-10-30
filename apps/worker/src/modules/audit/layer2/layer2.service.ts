import { Injectable, Logger } from '@nestjs/common';
import { getPool } from '@devsentinel/database';
import { tokenEstimator, type ProjectProfile, type RecentCommit, type ReviewResult, type TriageResult } from '@devsentinel/llm-port';
import { estimateMaxCostUsd, getAuditBudget, getMonthSpendUsd, getRunSpendUsd, type AuditBudget } from '@devsentinel/settings';
import { inputBudgetFor, withContextRetry } from '../../../common/contextBudget';
import { createLayerRouter, type UsageSink } from '../../../common/llmRouter.factory';
import { charsForTokens, chunkDiff } from '../../review/inputBudget';
import type { Layer1Result } from '../types';
import { classifyChange, type ChangeTagResult } from './changeProfile';
import { buildTriageBase, triageInputForChunk } from './context';
import { evaluateEscalation, escalationConfigFromEnv, type EscalationResult } from './escalation';
import { mergeTriage } from './merge';
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
  /** El triaje no vio todo el código (cambio demasiado grande): la revisión derivada es parcial y no puede salir APTO. */
  partial: boolean;
  partialReason: string | null;
  /** Cuántas partes tuvo el triaje (un cambio grande se divide en varias llamadas) y a qué fracción del presupuesto se llegó tras reintentos. */
  chunks: { total: number; analyzed: number; scale: number };
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
/** Cuántas llamadas de triaje como máximo para un cambio grande (cada una cuesta). Lo que no entra queda como revisión parcial. */
const MAX_CHUNKS = Math.max(1, Number(process.env.AUDIT_L2_MAX_CHUNKS) || 4);
const MIN_CHUNK_CHARS = 20_000;

/** Señal interna: el presupuesto de dinero impidió la primera llamada (el resultado ya está armado). */
class BudgetStop extends Error {}

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
      partial: false,
      partialReason: null,
      chunks: { total: 0, analyzed: 0, scale: 1 },
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

    const tbase = await buildTriageBase({
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
    base.omittedFindings = tbase.omittedFindings;

    // ---- presupuesto de contexto de la capa: lo que cabe en CADA llamada (ventana real del agente menos la reserva de respuesta)
    const budget = await getAuditBudget(getPool());
    const ctxBudget = await inputBudgetFor('layer2');
    const model0 = ctxBudget.limitingModel ?? models[0];
    let chunkInfo: Layer2Outcome['chunks'] = { total: 1, analyzed: 1, scale: 1 };
    let stopped: Layer2Outcome | null = null;

    /** Una pasada completa (map): fragmenta el diff al tamaño que cabe y triaja cada fragmento por separado. */
    const runPass = async (scale: number) => {
      const room = charsForTokens(Math.floor(ctxBudget.inputTokens * scale), model0) - tbase.overheadChars - 1_500;
      const chunked = chunkDiff(tbase.redactedDiff, Math.max(MIN_CHUNK_CHARS * scale, room), MAX_CHUNKS, tbase.hints);
      const chunks = chunked.chunks.length ? chunked.chunks : [{ diff: '', files: [] as string[] }];
      const allFiles = new Set(chunks.flatMap((c) => c.files));
      const parts: TriageResult[] = [];
      let unaffordable: string | null = null;
      for (let i = 0; i < chunks.length; i++) {
        const input = triageInputForChunk(tbase, chunks[i], i, chunks.length, allFiles);
        const tokens = Math.ceil(JSON.stringify(input).length / tokenEstimator.charsPerToken(model0)) + 2_000;
        // el costo ya gastado en los fragmentos anteriores tiene que estar guardado antes de decidir si el siguiente se puede pagar
        if (i > 0) await sink.flush();
        const verdict = await this.affordable(budget, models[0], tokens, payload.reviewRunId);
        if (verdict) {
          if (i === 0) {
            stopped = await done({ status: 'skipped_budget', reason: verdict, models, budgetPolicy: budget.policy });
            throw new BudgetStop();
          }
          unaffordable = verdict;
          break;
        }
        parts.push(await layer.router.triageAudit(input));
      }
      return { triage: mergeTriage(parts), analyzed: parts.length, total: chunks.length, omittedFiles: chunked.omittedFiles, truncatedFiles: chunked.truncatedFiles, unaffordable };
    };

    // ---- llamadas al modelo (reintento inteligente: si aun así no cabe, se vuelve a fragmentar con un presupuesto menor, nunca igual)
    let triage: TriageResult;
    let omittedFiles: string[] = [];
    let truncatedFiles: string[] = [];
    try {
      const pass = await withContextRetry(
        async (scale, attempt) => {
          if (attempt > 1) this.logger.warn(`capa 2: reintento ${attempt} con el presupuesto al ${Math.round(scale * 100)}%`);
          const r = await runPass(scale);
          chunkInfo = { total: r.total, analyzed: r.analyzed, scale };
          return r;
        },
        { onRetry: (next) => this.logger.warn(`capa 2: la entrada no cabe en el modelo; se reintenta con un presupuesto del ${Math.round(next * 100)}%`) },
      );
      triage = pass.triage;
      omittedFiles = pass.omittedFiles;
      truncatedFiles = pass.truncatedFiles;
      if (pass.analyzed < pass.total) {
        base.partial = true;
        base.partialReason = `Solo se analizaron ${pass.analyzed} de ${pass.total} partes del cambio: ${pass.unaffordable}`;
      }
    } catch (err) {
      if (err instanceof BudgetStop && stopped) return stopped;
      const message = (err as Error).message.replace(/\s+/g, ' ').slice(0, 300);
      this.logger.error(`capa 2 falló en ${payload.owner}/${payload.repo}@${payload.commitSha.slice(0, 7)}: ${message}`);
      return done({ status: 'failed', reason: `El modelo de la capa 2 falló: ${message}`, models });
    }
    if (omittedFiles.length || truncatedFiles.length) {
      base.partial = true;
      base.partialReason ??= `${omittedFiles.length} archivo(s) de código no entraron al triaje y ${truncatedFiles.length} se recortaron por el tamaño del cambio.`;
    }
    base.chunks = chunkInfo;
    const answered = layer.router.calls.find((c) => c.ok && c.method === 'triageAudit');

    // ---- validación contra el repositorio real: nada del modelo se acepta tal cual
    const validated = await validateTriage(triage, {
      checkoutPath: params.checkoutPath,
      diffText: tbase.redactedDiff,
      refMap: tbase.refMap,
      orderedRefs: tbase.findings.map((f) => f.ref),
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

  /** null si la llamada cabe en el presupuesto de dinero; si no, el motivo. Usa una cota superior del costo (entrada estimada + salida máxima). */
  private async affordable(budget: AuditBudget, model: string, inputTokens: number, reviewRunId: string): Promise<string | null> {
    const pool = getPool();
    const estimate = await estimateMaxCostUsd(pool, model, inputTokens, MAX_OUTPUT_TOKENS);
    if (estimate === null) {
      this.logger.warn(`el modelo "${model}" no tiene tarifa en model_prices: la capa 2 corre sin poder limitar su costo por presupuesto`);
      return null;
    }
    const [month, runSpent] = await Promise.all([getMonthSpendUsd(pool), getRunSpendUsd(pool, reviewRunId)]);
    if (month + estimate > budget.monthlyUsd) {
      return `Presupuesto mensual de IA agotado: gastado ${month.toFixed(2)} USD de ${budget.monthlyUsd.toFixed(2)} y esta llamada podría costar hasta ${estimate.toFixed(2)} USD.`;
    }
    if (runSpent + estimate > budget.perAuditUsd) {
      return `Límite por auditoría superado: esta auditoría lleva ${runSpent.toFixed(2)} USD de ${budget.perAuditUsd.toFixed(2)} y la capa 2 podría costar hasta ${estimate.toFixed(2)} USD.`;
    }
    return null;
  }
}
