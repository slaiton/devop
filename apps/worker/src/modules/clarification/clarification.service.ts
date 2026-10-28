import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { withTenant } from '@devsentinel/database';
import { buildGithubAdapterForInstallation } from '@devsentinel/github-apps';
import type { GitProviderPort } from '@devsentinel/git-providers';
import { AgenticReviewUnsupportedError, type AgenticReviewOptions, type ClarificationResult, type ResolveClarificationInput } from '@devsentinel/llm-port';
import type { ClarificationJobPayload } from '@devsentinel/event-contracts';
import { upsertFindingsIssue } from '@devsentinel/issue-content';
import { createLlmRouter } from '../../common/llmRouter.factory';
import { checkConclusion, loadGateConfig, recomputeGateDecision, type GateDecision } from '../../common/gate';
import { RemoteToolbox } from './remoteToolbox';

/** Cuántas preguntas de la IA caben en un hallazgo: la primera y una repregunta. Después decide una persona. */
export const MAX_CLARIFICATION_ROUNDS = 2;

const AGENT_OPTIONS: AgenticReviewOptions = { maxRounds: 6, maxToolCalls: 14, maxToolChars: 60_000, deadlineMs: 120_000 };

type Outcome =
  | { kind: 'confirmed'; explanation: string; severity: string | null; score: number | null; risk: 'low' | 'medium' | 'high' | null }
  | { kind: 'dismissed'; explanation: string; score: number | null; risk: 'low' | 'medium' | 'high' | null }
  | { kind: 'ask_again'; explanation: string; question: string; verifyWith: unknown }
  | { kind: 'needs_human'; explanation: string };

/**
 * Re-evalúa un hallazgo que quedó como pregunta cuando el desarrollador responde (en la plataforma o en GitHub) o cuando un
 * admin decide a mano. La IA puede verificar lo que dijo el desarrollador leyendo otros repos de la misma instalación. El
 * resultado es uno de: confirmado (pasa a bloquear según su severidad), descartado, repregunta (una vez) o, si ya no hay
 * más rondas, pendiente de una persona. Siempre se recalcula el veredicto del commit y se actualiza GitHub.
 */
@Injectable()
export class ClarificationService {
  private readonly logger = new Logger(ClarificationService.name);

  async process(payload: ClarificationJobPayload): Promise<void> {
    // El agente de IA se arma antes de abrir la transacción: si no hay ninguno configurado falla rápido y se reintenta.
    const llm = payload.kind === 'reply' ? await createLlmRouter() : null;

    await withTenant(payload.organizationId, async (client) => {
      // Bloquea la fila: si llegan dos respuestas seguidas, la segunda espera a que termine la primera y ve el resultado.
      const { rows: findingRows } = await client.query('SELECT * FROM findings WHERE id = $1 FOR UPDATE', [payload.findingId]);
      const finding = findingRows[0];
      if (!finding || finding.status !== 'awaiting_clarification') {
        this.logger.log(`hallazgo ${payload.findingId} ya no está pendiente de aclaración: se omite`);
        return;
      }

      if (payload.kind === 'reply') {
        // Si dos respuestas seguidas encolaron dos trabajos, el primero ya las vio ambas: el segundo no tiene nada nuevo que evaluar.
        const { rows: last } = await client.query(
          'SELECT role FROM finding_clarifications WHERE finding_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
          [payload.findingId],
        );
        if (last[0]?.role !== 'developer') {
          this.logger.log(`hallazgo ${payload.findingId}: no hay una respuesta nueva que evaluar: se omite`);
          return;
        }
      }

      const { rows: runRows } = await client.query(
        `SELECT rr.commit_sha, rr.quality_score, rr.risk_level, rr.gate_decision, rr.pull_request_id, rr.branch, rr.summary,
                r.full_name, gi.installation_id, pr.github_pr_number, d.github_login
         FROM review_runs rr
         JOIN repositories r ON r.id = rr.repository_id
         JOIN github_installations gi ON gi.id = r.github_installation_id
         LEFT JOIN pull_requests pr ON pr.id = rr.pull_request_id
         LEFT JOIN developers d ON d.id = rr.developer_id
         WHERE rr.id = $1`,
        [payload.reviewRunId],
      );
      const run = runRows[0];
      if (!run) {
        this.logger.warn(`review run ${payload.reviewRunId} no existe: se omite`);
        return;
      }

      const [owner, repo] = String(run.full_name).split('/');
      const installationId = Number(run.installation_id);
      const gitAdapter = await buildGithubAdapterForInstallation(client, installationId);

      const outcome =
        payload.kind === 'manual'
          ? this.manualOutcome(payload)
          : await this.askTheAi({ client, llm: llm!, gitAdapter, finding, run, owner, repo, installationId });

      await this.apply({ client, payload, finding, run, outcome, gitAdapter, owner, repo, installationId });
    });
  }

  // ------------------------------------------------------------------------------------------------------------------

  private manualOutcome(payload: ClarificationJobPayload): Outcome {
    const comment = payload.manual?.comment?.trim();
    if (payload.manual?.decision === 'confirm') {
      return { kind: 'confirmed', explanation: comment || 'Un administrador confirmó el hallazgo.', severity: null, score: null, risk: null };
    }
    return { kind: 'dismissed', explanation: comment || 'Un administrador descartó el hallazgo.', score: null, risk: null };
  }

  private async askTheAi(ctx: {
    client: PoolClient;
    llm: Awaited<ReturnType<typeof createLlmRouter>>;
    gitAdapter: GitProviderPort;
    finding: any;
    run: any;
    owner: string;
    repo: string;
    installationId: number;
  }): Promise<Outcome> {
    const { client, llm, gitAdapter, finding, run, owner, repo, installationId } = ctx;

    const { rows: thread } = await client.query(
      `SELECT role, body, author_login FROM finding_clarifications WHERE finding_id = $1 ORDER BY created_at, id`,
      [finding.id],
    );
    const { rows: readableRows } = await client.query(
      `SELECT r.full_name FROM repositories r JOIN github_installations gi ON gi.id = r.github_installation_id
       WHERE gi.installation_id = $1 ORDER BY r.full_name`,
      [installationId],
    );
    const readable: string[] = readableRows.map((r: { full_name: string }) => r.full_name);

    const diff = run.github_pr_number
      ? await gitAdapter.getPullRequestDiff({ installationId, owner, repo, pullNumber: run.github_pr_number })
      : await gitAdapter.getCommitDiff({ installationId, owner, repo, commitSha: run.commit_sha });

    const input: ResolveClarificationInput = {
      repositoryFullName: run.full_name,
      commitSha: run.commit_sha,
      diff,
      finding: {
        category: finding.category,
        severity: finding.severity,
        file_path: finding.file_path,
        line_start: finding.line_start,
        title: finding.title,
        explanation: finding.explanation,
        question: finding.question ?? '',
        verify_with: finding.verify_with ?? null,
      },
      thread: thread.map((m: { role: 'ai' | 'developer' | 'system'; body: string; author_login: string | null }) => ({
        role: m.role,
        body: m.body,
        author: m.author_login,
      })),
      round: Math.max(1, finding.clarification_round),
      maxRounds: MAX_CLARIFICATION_ROUNDS,
      currentQualityScore: run.quality_score ?? 0,
      currentRiskLevel: run.risk_level ?? 'medium',
      readableRepositories: readable.filter((name) => name.toLowerCase() !== `${owner}/${repo}`.toLowerCase()),
    };

    const toolbox = new RemoteToolbox({
      git: gitAdapter,
      installationId,
      owner,
      repo,
      commitSha: run.commit_sha,
      pullNumber: run.github_pr_number ?? undefined,
      readable,
    });

    let result: ClarificationResult;
    try {
      result = (await llm.resolveClarificationAgentic(input, toolbox, AGENT_OPTIONS)).result;
    } catch (err) {
      if (!(err instanceof AgenticReviewUnsupportedError)) throw err; // caída real: BullMQ reintenta
      // Ningún agente soporta herramientas: se decide con la conversación y el diff, sin verificar otros repos.
      result = await llm.resolveClarification(input);
    }

    const lastRound = input.round >= input.maxRounds;
    if (result.decision === 'confirmed') {
      return { kind: 'confirmed', explanation: result.explanation, severity: result.severity ?? null, score: result.updated_quality_score, risk: result.updated_risk_level };
    }
    if (result.decision === 'dismissed') {
      return { kind: 'dismissed', explanation: result.explanation, score: result.updated_quality_score, risk: result.updated_risk_level };
    }
    const question = result.question?.trim();
    if (lastRound || !question) return { kind: 'needs_human', explanation: result.explanation };
    return { kind: 'ask_again', explanation: result.explanation, question, verifyWith: result.verify_with ?? null };
  }

  // ------------------------------------------------------------------------------------------------------------------

  private async apply(ctx: {
    client: PoolClient;
    payload: ClarificationJobPayload;
    finding: any;
    run: any;
    outcome: Outcome;
    gitAdapter: GitProviderPort;
    owner: string;
    repo: string;
    installationId: number;
  }): Promise<void> {
    const { client, payload, finding, run, outcome, gitAdapter, owner, repo, installationId } = ctx;
    const manualUser = payload.kind === 'manual' ? (payload.manual?.userId ?? null) : null;

    // 1) El hallazgo y la conversación
    if (outcome.kind === 'confirmed') {
      const severity = outcome.severity ?? finding.severity;
      await client.query(
        `UPDATE findings SET status = 'open', severity = $2, needs_human = false,
                explanation = explanation || E'\\n\\nConfirmado tras la aclaración: ' || $3
         WHERE id = $1`,
        [finding.id, severity, outcome.explanation],
      );
    } else if (outcome.kind === 'dismissed') {
      await client.query(
        `UPDATE findings SET status = 'dismissed_false_positive', needs_human = false, blocking = false,
                resolution_comment = $2, resolved_by = $3, resolved_at = now()
         WHERE id = $1`,
        [finding.id, outcome.explanation, manualUser],
      );
    } else if (outcome.kind === 'ask_again') {
      await client.query(
        `UPDATE findings SET question = $2, verify_with = $3, clarification_round = clarification_round + 1,
                needs_human = false, question_posted_at = NULL
         WHERE id = $1`,
        [finding.id, outcome.question, outcome.verifyWith ? JSON.stringify(outcome.verifyWith) : null],
      );
    } else {
      await client.query('UPDATE findings SET needs_human = true WHERE id = $1', [finding.id]);
    }

    const body =
      payload.kind === 'manual'
        ? `${outcome.kind === 'confirmed' ? 'Confirmado' : 'Descartado'} por un administrador. ${outcome.explanation}`.trim()
        : outcome.kind === 'ask_again'
          ? `${outcome.explanation}\n\nPregunta: ${outcome.question}`
          : outcome.kind === 'needs_human'
            ? `${outcome.explanation}\n\nNo puedo decidirlo con lo que hay: un administrador debe confirmar o descartar este hallazgo.`
            : outcome.explanation;
    await client.query(
      `INSERT INTO finding_clarifications (organization_id, finding_id, role, body, source, posted_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [payload.organizationId, finding.id, payload.kind === 'manual' ? 'system' : 'ai', body, payload.kind === 'manual' ? 'platform' : 'ai', manualUser],
    );

    // 2) El veredicto del commit
    let gate: GateDecision = run.gate_decision;
    let score: number = run.quality_score ?? 0;
    let risk: 'low' | 'medium' | 'high' = run.risk_level ?? 'medium';
    if (outcome.kind === 'confirmed' || outcome.kind === 'dismissed') {
      score = outcome.score ?? score;
      risk = outcome.risk ?? risk;
      const config = await loadGateConfig(client, payload.organizationId, payload.repositoryId);
      gate = await recomputeGateDecision(client, payload.reviewRunId, risk, score, config);
      // Un hallazgo confirmado bloquea solo si el commit quedó NO APTO y es grave (misma regla que al analizar).
      if (outcome.kind === 'confirmed') {
        await client.query(
          `UPDATE findings SET blocking = ($2 = 'no_apto' AND severity IN ('critical', 'high')) WHERE id = $1`,
          [finding.id, gate],
        );
      }
      // completed_at se mueve para que el aviso en vivo anuncie que el análisis cambió.
      await client.query(
        `UPDATE review_runs SET quality_score = $1, risk_level = $2, gate_decision = $3, completed_at = now() WHERE id = $4`,
        [score, risk, gate, payload.reviewRunId],
      );
    }

    // 3) GitHub (un fallo aquí no deshace lo ya decidido: se registra)
    await this.safely(`check del commit ${run.commit_sha}`, async () => {
      if (gate === run.gate_decision) return;
      await gitAdapter.setCheckRunStatus({
        installationId,
        owner,
        repo,
        commitSha: run.commit_sha,
        conclusion: checkConclusion(gate),
        title:
          gate === 'apto'
            ? 'Aprobado por DevSentinel AI (tras aclarar)'
            : gate === 'requiere_revision'
              ? 'Requiere revisión humana — DevSentinel AI'
              : 'Bloqueado por DevSentinel AI (hallazgo confirmado)',
        summary: outcome.explanation,
      });
    });

    await this.safely('issue de seguimiento', async () => {
      await upsertFindingsIssue(client, gitAdapter, {
        organizationId: payload.organizationId,
        repositoryId: payload.repositoryId,
        installationId,
        owner,
        repo,
        repositoryFullName: run.full_name,
        pullRequestId: run.pull_request_id,
        pullRequestNumber: run.github_pr_number ?? null,
        branch: run.branch,
        commitSha: run.commit_sha,
        reviewRunId: payload.reviewRunId,
        reviewRun: { gate_decision: gate, quality_score: score, risk_level: risk, summary: run.summary },
        trigger: 'reconsideration',
        resolutionContext: `aclaración de "${finding.title}" — ${outcome.explanation}`,
        mentionLogin: run.github_login ?? null,
      });
    });

    if (outcome.kind !== 'ask_again') {
      await this.safely('comentario de resultado', async () => {
        const { rows } = await client.query(
          `SELECT github_issue_number FROM issues WHERE repository_id = $1 AND kind = 'findings' AND review_run_id = $2 LIMIT 1`,
          [payload.repositoryId, payload.reviewRunId],
        );
        if (!rows[0]) return;
        const head =
          outcome.kind === 'confirmed'
            ? `🔎 Re: **${finding.title}** — hallazgo confirmado.`
            : outcome.kind === 'dismissed'
              ? `✅ Re: **${finding.title}** — hallazgo descartado.`
              : `🧑‍⚖️ Re: **${finding.title}** — la IA no pudo decidirlo; un administrador debe confirmarlo o descartarlo en DevSentinel.`;
        await gitAdapter.postIssueComment({
          installationId,
          owner,
          repo,
          issueNumber: rows[0].github_issue_number,
          body: `${head}\n\n${outcome.explanation}`,
        });
      });
    }
  }

  private async safely(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.error(`no se pudo actualizar GitHub (${what}): ${(err as Error).message}`, (err as Error).stack);
    }
  }
}
