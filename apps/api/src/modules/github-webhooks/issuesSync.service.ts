import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { PoolClient } from 'pg';
import { withTenant } from '@devsentinel/database';
import { CLARIFICATION_QUEUE_NAME, type ClarificationJobPayload } from '@devsentinel/event-contracts';
import type { WebhookAppContext } from './github-webhooks.service';
import { ignored, processed, type WebhookOutcome } from './webhookOutcome';

/** Sincroniza los eventos `issues`/`issue_comment` del webhook de GitHub hacia las
 * tablas locales `issues`/`issue_comments` — espejo de TODO issue del repo, no solo
 * los que crea DevSentinel (ver plan de la feature). Vive junto a
 * `GithubWebhooksService` porque reutiliza el mismo patrón de resolución de tenant
 * (duplicado a propósito, mismo criterio que `getAdapter()` en otros servicios del
 * repo, para no acoplar los dos servicios). */
@Injectable()
export class IssuesSyncService {
  constructor(@InjectQueue(CLARIFICATION_QUEUE_NAME) private readonly clarificationQueue: Queue<ClarificationJobPayload>) {}

  async handleIssueEvent(payload: any, ctx: WebhookAppContext): Promise<WebhookOutcome> {
    const fullName: string | undefined = payload.repository?.full_name;
    // Los eventos de PR-como-issue (comentarios de conversación de un PR) ya se
    // reflejan vía el flujo de `pull_request` — no duplicar acá.
    if (payload.issue?.pull_request) {
      return ignored('issue_is_pr', { detail: 'es un PR visto como issue: se sincroniza por el flujo de pull_request', repository: fullName });
    }
    // La organización es la dueña de la App que mandó el webhook (ya autenticado): no hace falta
    // adivinarla desde la instalación, que puede no estar enlazada todavía.
    const orgId = ctx.organizationId;
    const repositoryId = await this.getRepositoryId(orgId, payload.repository.id);
    if (!repositoryId) {
      return ignored('repo_unregistered', {
        detail: 'el repositorio todavía no está sincronizado en esta organización (usa "Sincronizar" en Cuentas GitHub)',
        repository: fullName,
      });
    }

    const issue = payload.issue;
    await withTenant(orgId, async (client) => {
      await this.upsertIssueMirror(client, orgId, repositoryId, issue);
    });
    return processed('issue_synced', { detail: `issue #${issue.number} sincronizado`, repository: fullName });
  }

  async handleIssueCommentEvent(payload: any, ctx: WebhookAppContext): Promise<WebhookOutcome> {
    const fullName: string | undefined = payload.repository?.full_name;
    if (payload.issue?.pull_request) {
      const answered = await this.intakePullRequestComment(ctx.organizationId, payload);
      if (answered > 0) {
        return processed('clarification_received', {
          detail: `el comentario del PR #${payload.issue.number} responde ${answered} pregunta(s) de la IA: se reevalúa`,
          repository: fullName,
        });
      }
      return ignored('issue_is_pr', { detail: 'es un comentario de conversación de un PR', repository: fullName });
    }
    const orgId = ctx.organizationId;
    const repositoryId = await this.getRepositoryId(orgId, payload.repository.id);
    if (!repositoryId) {
      return ignored('repo_unregistered', {
        detail: 'el repositorio todavía no está sincronizado en esta organización (usa "Sincronizar" en Cuentas GitHub)',
        repository: fullName,
      });
    }

    const comment = payload.comment;

    let answered: ClarificationJobPayload[] = [];
    await withTenant(orgId, async (client) => {
      const issueId = await this.upsertIssueMirror(client, orgId, repositoryId, payload.issue);

      if (payload.action === 'deleted') {
        await client.query(
          `UPDATE issue_comments SET deleted_at = now() WHERE issue_id = $1 AND github_comment_id = $2`,
          [issueId, comment.id],
        );
        return;
      }

      // ON CONFLICT nunca toca `source`/`posted_by`: si esta fila ya existe porque la
      // insertamos nosotros al publicar (IssuesService.postComment), este upsert del
      // webhook solo refresca el texto/autor, no reclasifica el origen del comentario.
      await client.query(
        `INSERT INTO issue_comments (organization_id, issue_id, github_comment_id, author_login, body, source, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'github', $6, $7)
         ON CONFLICT (issue_id, github_comment_id) WHERE github_comment_id IS NOT NULL DO UPDATE SET
           body = $5, author_login = $4, updated_at = $7`,
        [orgId, issueId, comment.id, comment.user?.login ?? null, comment.body ?? '', comment.created_at, comment.updated_at ?? null],
      );

      // ¿Es la respuesta a una pregunta de la IA? Solo los comentarios NUEVOS de personas en el issue de seguimiento de un análisis.
      if (payload.action === 'created' && !this.isBot(comment)) {
        const { rows } = await client.query("SELECT kind, review_run_id FROM issues WHERE id = $1", [issueId]);
        if (rows[0]?.kind === 'findings' && rows[0].review_run_id) {
          answered = await this.recordAnswers(client, orgId, repositoryId, [rows[0].review_run_id], comment);
        }
      }
    });
    for (const job of answered) await this.enqueueClarification(job, comment.id);
    if (answered.length > 0) {
      return processed('clarification_received', {
        detail: `el comentario del issue #${payload.issue?.number} responde ${answered.length} pregunta(s) de la IA: se reevalúa`,
        repository: fullName,
      });
    }
    return processed('issue_synced', { detail: `comentario en el issue #${payload.issue?.number} sincronizado`, repository: fullName });
  }

  private isBot(comment: any): boolean {
    return comment?.user?.type === 'Bot' || String(comment?.user?.login ?? '').endsWith('[bot]');
  }

  /** Comentario de conversación de un PR: si el PR tiene preguntas de la IA pendientes, el comentario las responde. */
  private async intakePullRequestComment(orgId: string, payload: any): Promise<number> {
    const comment = payload.comment;
    if (payload.action !== 'created' || !comment || this.isBot(comment)) return 0;
    const repositoryId = await this.getRepositoryId(orgId, payload.repository.id);
    if (!repositoryId) return 0;
    let jobs: ClarificationJobPayload[] = [];
    await withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT rr.id FROM pull_requests pr
         JOIN review_runs rr ON rr.pull_request_id = pr.id OR rr.id = pr.source_review_run_id
         WHERE pr.repository_id = $1 AND pr.github_pr_number = $2`,
        [repositoryId, payload.issue.number],
      );
      jobs = await this.recordAnswers(client, orgId, repositoryId, rows.map((r: { id: string }) => r.id), comment);
    });
    for (const job of jobs) await this.enqueueClarification(job, comment.id);
    return jobs.length;
  }

  /** Registra el comentario como respuesta del desarrollador en cada hallazgo que sigue como pregunta. Idempotente por comentario
   * de GitHub (el webhook puede llegar repetido). Devuelve los trabajos de re-evaluación a encolar. */
  private async recordAnswers(
    client: PoolClient,
    orgId: string,
    repositoryId: string,
    reviewRunIds: string[],
    comment: any,
  ): Promise<ClarificationJobPayload[]> {
    const body = String(comment.body ?? '').trim();
    if (!body) return [];
    const { rows: findings } = await client.query(
      `SELECT id, review_run_id FROM findings WHERE review_run_id = ANY($1::uuid[]) AND status = 'awaiting_clarification'`,
      [reviewRunIds],
    );
    const jobs: ClarificationJobPayload[] = [];
    for (const f of findings) {
      const { rows: inserted } = await client.query(
        `INSERT INTO finding_clarifications (organization_id, finding_id, role, body, author_login, source, github_comment_id)
         VALUES ($1, $2, 'developer', $3, $4, 'github', $5)
         ON CONFLICT (finding_id, github_comment_id) WHERE github_comment_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [orgId, f.id, body.slice(0, 4000), comment.user?.login ?? null, comment.id],
      );
      if (inserted[0]) {
        await client.query('UPDATE findings SET needs_human = false WHERE id = $1', [f.id]);
        jobs.push({ organizationId: orgId, repositoryId, reviewRunId: f.review_run_id, findingId: f.id, kind: 'reply' });
      }
    }
    return jobs;
  }

  private async enqueueClarification(job: ClarificationJobPayload, commentId: number): Promise<void> {
    await this.clarificationQueue.add(CLARIFICATION_QUEUE_NAME, job, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 20_000 },
      removeOnComplete: true,
      removeOnFail: 50,
      jobId: `clar-gh-${job.findingId}-${commentId}`,
    });
  }

  /** Upsert del espejo de un issue por (repository_id, github_issue_number). En
   * INSERT (issue nunca visto) se clasifica `kind='manual', origin='github'`; en
   * UPDATE solo se tocan los campos espejo de GitHub — nunca `kind/origin/
   * pull_request_id/branch/review_run_id/ai_suggested_reply*`, que son terreno del
   * flujo de negocio (`upsertFindingsIssue`), para que un cierre/edición manual en
   * GitHub no pise la clasificación que puso nuestro propio sistema. */
  private async upsertIssueMirror(client: PoolClient, orgId: string, repositoryId: string, issue: any): Promise<string> {
    const { rows } = await client.query(
      `INSERT INTO issues
         (organization_id, repository_id, github_issue_number, kind, origin,
          title, body, state, state_reason, author_login, created_at, updated_at, closed_at, last_synced_at)
       VALUES ($1, $2, $3, 'manual', 'github', $4, $5, $6, $7, $8, $9, $10, $11, now())
       ON CONFLICT (repository_id, github_issue_number) DO UPDATE SET
         title = $4, body = $5, state = $6, state_reason = $7, author_login = $8,
         updated_at = $10, closed_at = $11, last_synced_at = now()
       RETURNING id`,
      [
        orgId,
        repositoryId,
        issue.number,
        issue.title,
        issue.body ?? '',
        issue.state,
        issue.state_reason ?? null,
        issue.user?.login ?? null,
        issue.created_at,
        issue.updated_at,
        issue.closed_at ?? null,
      ],
    );
    return rows[0].id as string;
  }

  private async getRepositoryId(orgId: string, githubRepoId: number): Promise<string | null> {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query('SELECT id FROM repositories WHERE github_repo_id = $1', [githubRepoId]);
      return rows[0]?.id ?? null;
    });
  }
}
