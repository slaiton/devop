import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { withTenant } from '@devsentinel/database';
import { buildGithubAdapterForInstallation } from '@devsentinel/github-apps';
import { buildPullRequestContent } from '@devsentinel/pr-content';

const MERGEABLE_POLL_ATTEMPTS = 6;
const MERGEABLE_POLL_INTERVAL_MS = 1500;

export interface MergeValidation {
  canMerge: boolean;
  reasons: string[];
  /** GitHub no terminó de calcular si es mergeable: conviene reintentar en unos segundos. */
  pending: boolean;
  summary: {
    number: number;
    title: string;
    url: string;
    head: string;
    base: string;
    verdict: string | null;
    score: number | null;
    risk: string | null;
    checks: { name: string; status: string; conclusion: string | null }[];
  };
}

interface Actor {
  userId: string;
  role: string;
}

@Injectable()
export class PullRequestsService {
  async createFromPush(orgId: string, repositoryId: string, reviewRunId: string) {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT rr.commit_sha, rr.branch, rr.trigger, rr.status, rr.gate_decision, rr.quality_score,
                rr.risk_level, rr.summary,
                r.full_name, gi.installation_id,
                COALESCE(qgc.promotion_source_branch, 'staging') AS promotion_source_branch,
                COALESCE(qgc.promotion_target_branch, 'main') AS promotion_target_branch
         FROM review_runs rr
         JOIN repositories r ON r.id = rr.repository_id
         JOIN github_installations gi ON gi.id = r.github_installation_id
         LEFT JOIN quality_gate_configs qgc ON qgc.organization_id = r.organization_id AND qgc.repository_id = r.id
         WHERE rr.id = $1 AND rr.repository_id = $2`,
        [reviewRunId, repositoryId],
      );
      const run = rows[0];
      if (!run) throw new NotFoundException('review run not found');
      if (run.trigger !== 'push') throw new BadRequestException('solo se pueden crear PRs a partir de un push');
      if (run.status !== 'completed') throw new BadRequestException('el análisis de este push todavía no terminó');

      const [owner, repo] = String(run.full_name).split('/');
      const installationId = Number(run.installation_id);
      const adapter = await buildGithubAdapterForInstallation(client, installationId);
      const base = run.promotion_target_branch;

      const { rows: findingRows } = await client.query(
        `SELECT category, severity, file_path, line_start, title, explanation, blocking, violated_rule
         FROM findings WHERE review_run_id = $1`,
        [reviewRunId],
      );

      const { title, body } = buildPullRequestContent({
        repositoryFullName: run.full_name,
        branch: run.branch,
        commitSha: run.commit_sha,
        reviewRun: run,
        findings: findingRows,
      });

      const existing = await adapter.findOpenPullRequest({ installationId, owner, repo, head: run.branch, base });

      let prNumber: number;
      let authorLogin: string;
      const skipComments = Boolean(existing); // ya existía en GitHub — no volver a comentar los hallazgos.

      if (existing) {
        prNumber = existing.number;
        authorLogin = 'unknown';
      } else {
        const created = await adapter.createPullRequest({ installationId, owner, repo, head: run.branch, base, title, body });
        prNumber = created.number;
        authorLogin = created.authorLogin;
      }

      const { rows: inserted } = await client.query(
        `INSERT INTO pull_requests
           (organization_id, repository_id, github_pr_number, title, source_branch, target_branch, author_login, status, source_review_run_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, 'devsentinel')
         ON CONFLICT (repository_id, github_pr_number) DO UPDATE
           SET source_review_run_id = $8, created_by = 'devsentinel'
         RETURNING *`,
        [orgId, repositoryId, prNumber, title, run.branch, base, authorLogin, reviewRunId],
      );

      if (!skipComments) {
        for (const finding of findingRows) {
          if (!finding.line_start) continue;
          await adapter.postReviewComment({
            installationId,
            owner,
            repo,
            pullNumber: prNumber,
            commitSha: run.commit_sha,
            filePath: finding.file_path,
            line: finding.line_start,
            body: `**[${finding.severity.toUpperCase()}] ${finding.title}**${finding.violated_rule ? `\n_Regla incumplida: ${finding.violated_rule}_` : ''}\n\n${finding.explanation}`,
          });
        }
      }

      return inserted[0];
    });
  }

  async listForRepository(orgId: string, repositoryId: string, actor: Actor) {
    return withTenant(orgId, async (client) => {
      if (actor.role !== 'admin' && !(await this.isRepoMember(client, repositoryId, actor.userId))) {
        return [];
      }
      const { rows } = await client.query(
        `SELECT pr.*,
                COALESCE(source_rr.quality_score, native_rr.quality_score) AS quality_score,
                COALESCE(source_rr.risk_level, native_rr.risk_level) AS risk_level,
                COALESCE(source_rr.gate_decision, native_rr.gate_decision) AS gate_decision
         FROM pull_requests pr
         LEFT JOIN review_runs source_rr ON source_rr.id = pr.source_review_run_id
         LEFT JOIN LATERAL (
           SELECT quality_score, risk_level, gate_decision
           FROM review_runs
           WHERE review_runs.pull_request_id = pr.id
           ORDER BY started_at DESC
           LIMIT 1
         ) native_rr ON true
         WHERE pr.repository_id = $1
         ORDER BY pr.created_at DESC`,
        [repositoryId],
      );
      return rows;
    });
  }

  async getById(orgId: string, pullRequestId: string, actor: Actor) {
    return withTenant(orgId, async (client) => {
      const pr = await this.loadWithOwnership(client, pullRequestId);
      if (!pr) throw new NotFoundException('pull request not found');
      await this.assertCanView(client, pr, actor);
      return pr;
    });
  }

  async getStatus(orgId: string, pullRequestId: string, actor: Actor) {
    return withTenant(orgId, async (client) => {
      const { installationId, owner, repo, pr } = await this.loadGithubRef(client, pullRequestId);
      await this.assertCanView(client, pr, actor);
      const adapter = await buildGithubAdapterForInstallation(client, installationId);
      return adapter.getPullRequestStatus({ installationId, owner, repo, pullNumber: pr.github_pr_number });
    });
  }

  async getAnalysis(orgId: string, pullRequestId: string, actor: Actor) {
    return withTenant(orgId, async (client) => {
      const pr = await this.loadWithOwnership(client, pullRequestId);
      if (!pr) throw new NotFoundException('pull request not found');
      await this.assertCanView(client, pr, actor);

      const { rows: runRows } = await client.query(
        `SELECT * FROM review_runs
         WHERE id = $1 OR (pull_request_id = $2)
         ORDER BY (id = $1) DESC, started_at DESC
         LIMIT 1`,
        [pr.source_review_run_id, pullRequestId],
      );
      const run = runRows[0];
      if (!run) return null;

      const { rows: findingRows } = await client.query(
        `SELECT * FROM findings WHERE review_run_id = $1
         ORDER BY (CASE severity
           WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END) DESC`,
        [run.id],
      );
      return { ...run, findings: findingRows };
    });
  }

  /** ¿Se puede mergear ahora? Además de decir sí/no con los motivos, devuelve el resumen que muestra la ventana de
   * confirmación (PR, ramas, veredicto del análisis, checks). Recién creado, GitHub tarda unos segundos en calcular si el
   * PR es mergeable (`unknown`): se espera ese cálculo en vez de mostrar un falso error. Las llamadas a GitHub se hacen
   * fuera de la transacción de base de datos para no tenerla abierta mientras se espera. */
  async validateMerge(orgId: string, pullRequestId: string): Promise<MergeValidation> {
    const ctx = await withTenant(orgId, async (client) => {
      const { installationId, owner, repo, pr } = await this.loadGithubRef(client, pullRequestId);
      const adapter = await buildGithubAdapterForInstallation(client, installationId);

      let analysisRunId = pr.source_review_run_id;
      if (!analysisRunId) {
        const { rows } = await client.query(
          `SELECT id FROM review_runs WHERE pull_request_id = $1 ORDER BY started_at DESC LIMIT 1`,
          [pullRequestId],
        );
        analysisRunId = rows[0]?.id ?? null;
      }
      const run = analysisRunId
        ? (await client.query(`SELECT status, gate_decision, quality_score, risk_level FROM review_runs WHERE id = $1`, [analysisRunId])).rows[0]
        : null;
      return { installationId, owner, repo, pr, adapter, hasAnalysis: Boolean(analysisRunId), run };
    });

    const { installationId, owner, repo, pr, adapter } = ctx;
    const reasons: string[] = [];
    if (pr.status !== 'open') reasons.push(`el PR ya está ${pr.status}`);

    const ref = { installationId, owner, repo, pullNumber: pr.github_pr_number };
    let status = await adapter.getPullRequestStatus(ref);
    for (let attempt = 0; attempt < MERGEABLE_POLL_ATTEMPTS && status.state === 'open' && status.mergeableState === 'unknown'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, MERGEABLE_POLL_INTERVAL_MS));
      status = await adapter.getPullRequestStatus(ref);
    }

    let pending = false;
    if (status.state !== 'open') reasons.push('el PR no está abierto en GitHub');
    if (status.draft) reasons.push('el PR sigue en borrador');
    if (status.mergeableState === 'dirty') reasons.push('hay conflictos con la rama destino');
    else if (status.mergeableState === 'behind') reasons.push('la rama está desactualizada respecto al destino');
    else if (status.mergeableState === 'blocked') reasons.push('bloqueado por revisiones o checks requeridos pendientes en GitHub');
    else if (status.mergeableState === 'unstable') reasons.push('hay checks no obligatorios fallando');
    else if (status.mergeableState === 'unknown' && status.state === 'open') {
      pending = true;
      reasons.push('GitHub todavía está calculando si el PR se puede mergear: intenta de nuevo en unos segundos');
    }

    if (!ctx.hasAnalysis) {
      reasons.push('no hay un análisis de DevSentinel asociado a este PR');
    } else if (!ctx.run || ctx.run.status !== 'completed') {
      reasons.push('el análisis de DevSentinel todavía no terminó');
    } else if (ctx.run.gate_decision === 'no_apto') {
      reasons.push('el análisis de DevSentinel marcó el commit como NO APTO');
    }

    return {
      canMerge: reasons.length === 0,
      reasons,
      pending,
      summary: {
        number: pr.github_pr_number,
        title: pr.title,
        url: `https://github.com/${owner}/${repo}/pull/${pr.github_pr_number}`,
        head: pr.source_branch,
        base: pr.target_branch,
        verdict: ctx.run?.gate_decision ?? null,
        score: ctx.run?.quality_score ?? null,
        risk: ctx.run?.risk_level ?? null,
        checks: status.checks.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion })),
      },
    };
  }

  async merge(orgId: string, pullRequestId: string): Promise<{ merged: boolean }> {
    const { canMerge, reasons } = await this.validateMerge(orgId, pullRequestId);
    if (!canMerge) {
      throw new BadRequestException(`no se puede mergear: ${reasons.join('; ')}`);
    }

    const { adapter, installationId, owner, repo, pr } = await withTenant(orgId, async (client) => {
      const ref = await this.loadGithubRef(client, pullRequestId);
      return { ...ref, adapter: await buildGithubAdapterForInstallation(client, ref.installationId) };
    });
    let result: { merged: boolean };
    try {
      result = await adapter.mergePullRequest({ installationId, owner, repo, pullNumber: pr.github_pr_number });
    } catch (err) {
      // GitHub puede rechazar el merge aunque la validación previa pasara (otro merge en paralelo, regla de rama protegida,
      // PR modificado justo antes): se explica en vez de devolver un error interno.
      const status = (err as { status?: number }).status;
      if (status === 405 || status === 409 || status === 422) {
        throw new BadRequestException(`GitHub rechazó el merge: ${(err as Error).message}`);
      }
      throw err;
    }
    if (result.merged) {
      await withTenant(orgId, (client) => client.query(`UPDATE pull_requests SET status = 'merged', merged_at = now() WHERE id = $1`, [pullRequestId]));
    }
    return result;
  }

  private async loadWithOwnership(client: PoolClient, pullRequestId: string): Promise<any | null> {
    const { rows } = await client.query('SELECT * FROM pull_requests WHERE id = $1', [pullRequestId]);
    return rows[0] ?? null;
  }

  private async loadGithubRef(client: PoolClient, pullRequestId: string) {
    const pr = await this.loadWithOwnership(client, pullRequestId);
    if (!pr) throw new NotFoundException('pull request not found');
    const { rows } = await client.query(
      `SELECT r.full_name, gi.installation_id FROM repositories r
       JOIN github_installations gi ON gi.id = r.github_installation_id
       WHERE r.id = $1`,
      [pr.repository_id],
    );
    const repoRow = rows[0];
    if (!repoRow) throw new NotFoundException('repository not found');
    const [owner, repo] = String(repoRow.full_name).split('/');
    return { installationId: Number(repoRow.installation_id), owner, repo, pr };
  }

  private async isRepoMember(client: PoolClient, repositoryId: string, userId: string): Promise<boolean> {
    const { rows } = await client.query(
      'SELECT 1 FROM repository_members WHERE repository_id = $1 AND user_id = $2',
      [repositoryId, userId],
    );
    return rows.length > 0;
  }

  /** admin ve cualquier PR de la org; un usuario ("user") solo los de un repo que
   * tenga asignado en repository_members (mismo criterio que review_runs). */
  private async assertCanView(client: PoolClient, pr: { repository_id: string }, actor: Actor): Promise<void> {
    if (actor.role === 'admin') return;
    const allowed = await this.isRepoMember(client, pr.repository_id, actor.userId);
    if (!allowed) throw new ForbiddenException('no tienes acceso a este pull request');
  }
}
