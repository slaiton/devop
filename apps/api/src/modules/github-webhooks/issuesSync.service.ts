import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { getPool, withTenant } from '@devsentinel/database';

/** Sincroniza los eventos `issues`/`issue_comment` del webhook de GitHub hacia las
 * tablas locales `issues`/`issue_comments` — espejo de TODO issue del repo, no solo
 * los que crea DevSentinel (ver plan de la feature). Vive junto a
 * `GithubWebhooksService` porque reutiliza el mismo patrón de resolución de tenant
 * (duplicado a propósito, mismo criterio que `getAdapter()` en otros servicios del
 * repo, para no acoplar los dos servicios). */
@Injectable()
export class IssuesSyncService {
  async handleIssueEvent(payload: any): Promise<void> {
    // Los eventos de PR-como-issue (comentarios de conversación de un PR) ya se
    // reflejan vía el flujo de `pull_request` — no duplicar acá.
    if (payload.issue?.pull_request) return;

    const installationId: number | undefined = payload.installation?.id;
    if (!installationId) return;
    const orgId = await this.getOrgIdByInstallation(installationId);
    if (!orgId) return;
    const repositoryId = await this.getRepositoryId(orgId, payload.repository.id);
    if (!repositoryId) return;

    const issue = payload.issue;
    await withTenant(orgId, async (client) => {
      await this.upsertIssueMirror(client, orgId, repositoryId, issue);
    });
  }

  async handleIssueCommentEvent(payload: any): Promise<void> {
    if (payload.issue?.pull_request) return;

    const installationId: number | undefined = payload.installation?.id;
    if (!installationId) return;
    const orgId = await this.getOrgIdByInstallation(installationId);
    if (!orgId) return;
    const repositoryId = await this.getRepositoryId(orgId, payload.repository.id);
    if (!repositoryId) return;

    const comment = payload.comment;

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
         ON CONFLICT (issue_id, github_comment_id) DO UPDATE SET
           body = $5, author_login = $4, updated_at = $7`,
        [orgId, issueId, comment.id, comment.user?.login ?? null, comment.body ?? '', comment.created_at, comment.updated_at ?? null],
      );
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

  private async getOrgIdByInstallation(installationId: number): Promise<string | null> {
    const { rows } = await getPool().query('SELECT resolve_organization_for_installation($1) AS organization_id', [
      installationId,
    ]);
    return rows[0]?.organization_id ?? null;
  }

  private async getRepositoryId(orgId: string, githubRepoId: number): Promise<string | null> {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query('SELECT id FROM repositories WHERE github_repo_id = $1', [githubRepoId]);
      return rows[0]?.id ?? null;
    });
  }
}
