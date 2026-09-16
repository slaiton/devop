import type { GitProviderPort } from '@devsentinel/git-providers';
import { buildIssueContent, type IssueContentFinding, type IssueContentReviewRun } from './buildIssueContent';

/** Subconjunto de `pg.PoolClient` que necesita este helper — evita atar
 * `@devsentinel/issue-content` a una dependencia directa de `pg` solo por el tipo. */
export interface QueryableClient {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface UpsertFindingsIssueInput {
  organizationId: string;
  repositoryId: string;
  installationId: number;
  owner: string;
  repo: string;
  repositoryFullName: string;
  pullRequestId: string | null;
  pullRequestNumber: number | null;
  branch: string;
  commitSha: string;
  reviewRunId: string;
  reviewRun: IssueContentReviewRun;
}

interface ExistingIssueRow {
  id: string;
  github_issue_number: number;
  state: 'open' | 'closed';
}

/** Crea/actualiza/cierra el issue "de hallazgos bloqueantes" de un PR (o branch,
 * cuando no hay PR) a partir del estado actual de `findings` para ese review run — un
 * único issue por PR/branch, nunca duplicado (índice único parcial `issues_findings_*`
 * como red de seguridad final). Se llama tanto tras un análisis nuevo como tras una
 * reconsideración, siempre, porque también debe cerrar el issue cuando ya no queden
 * bloqueantes. `client` debe venir de una transacción `withTenant` ya abierta. */
export async function upsertFindingsIssue(
  client: QueryableClient,
  gitAdapter: GitProviderPort,
  input: UpsertFindingsIssueInput,
): Promise<void> {
  const { rows: findingRows } = await client.query(
    `SELECT category, severity, file_path, line_start, title, explanation, violated_rule
     FROM findings WHERE review_run_id = $1 AND status = 'open' AND blocking = true`,
    [input.reviewRunId],
  );
  const blockingFindings: IssueContentFinding[] = findingRows;

  // Bloquea la fila existente (si hay) dentro de la transacción para serializar
  // contra una ejecución concurrente sobre el mismo PR/branch (p. ej. una
  // reconsideración casi simultánea a un nuevo push).
  const { rows: existingRows } = await client.query(
    `SELECT id, github_issue_number, state FROM issues
     WHERE repository_id = $1 AND kind = 'findings'
       AND (($2::uuid IS NOT NULL AND pull_request_id = $2) OR ($2::uuid IS NULL AND branch = $3))
     FOR UPDATE`,
    [input.repositoryId, input.pullRequestId, input.branch],
  );
  const existing: ExistingIssueRow | undefined = existingRows[0];

  if (blockingFindings.length === 0) {
    if (existing && existing.state === 'open') {
      await gitAdapter.setIssueState({
        installationId: input.installationId,
        owner: input.owner,
        repo: input.repo,
        issueNumber: existing.github_issue_number,
        state: 'closed',
        stateReason: 'completed',
      });
      await gitAdapter.postIssueComment({
        installationId: input.installationId,
        owner: input.owner,
        repo: input.repo,
        issueNumber: existing.github_issue_number,
        body: 'DevSentinel AI: ya no quedan hallazgos bloqueantes vigentes — cerrando automáticamente.',
      });
      await client.query(
        `UPDATE issues SET state = 'closed', closed_at = now(), updated_at = now(), last_synced_at = now() WHERE id = $1`,
        [existing.id],
      );
    }
    return;
  }

  const { title, body } = buildIssueContent({
    repositoryFullName: input.repositoryFullName,
    pullRequestNumber: input.pullRequestNumber,
    branch: input.branch,
    commitSha: input.commitSha,
    reviewRun: input.reviewRun,
    blockingFindings,
    reviewRunId: input.reviewRunId,
  });

  if (existing) {
    await gitAdapter.updateIssue({
      installationId: input.installationId,
      owner: input.owner,
      repo: input.repo,
      issueNumber: existing.github_issue_number,
      title,
      body,
    });
    if (existing.state === 'closed') {
      await gitAdapter.setIssueState({
        installationId: input.installationId,
        owner: input.owner,
        repo: input.repo,
        issueNumber: existing.github_issue_number,
        state: 'open',
        stateReason: 'reopened',
      });
      await gitAdapter.postIssueComment({
        installationId: input.installationId,
        owner: input.owner,
        repo: input.repo,
        issueNumber: existing.github_issue_number,
        body: 'DevSentinel AI: reabriendo — hay nuevos hallazgos bloqueantes.',
      });
    }
    await client.query(
      `UPDATE issues
       SET title = $1, body = $2, review_run_id = $3, state = 'open', closed_at = NULL, updated_at = now(), last_synced_at = now()
       WHERE id = $4`,
      [title, body, input.reviewRunId, existing.id],
    );
    return;
  }

  const created = await gitAdapter.createIssue({
    installationId: input.installationId,
    owner: input.owner,
    repo: input.repo,
    title,
    body,
  });

  // ON CONFLICT sobre (repository_id, github_issue_number): si el webhook `issues.opened`
  // llegó primero y ya insertó una fila 'manual' para este número (raro pero posible en
  // la ventana entre crear en GitHub y confirmar aquí), esta escritura es la autoridad —
  // la acabamos de crear nosotros — así que sí sobreescribe kind/origin/pull_request_id.
  await client.query(
    `INSERT INTO issues
       (organization_id, repository_id, github_issue_number, pull_request_id, branch, review_run_id,
        kind, origin, title, body, state)
     VALUES ($1, $2, $3, $4, $5, $6, 'findings', 'devsentinel', $7, $8, 'open')
     ON CONFLICT (repository_id, github_issue_number) DO UPDATE SET
       pull_request_id = $4, branch = $5, review_run_id = $6, kind = 'findings', origin = 'devsentinel',
       title = $7, body = $8, state = 'open', closed_at = NULL, updated_at = now(), last_synced_at = now()`,
    [
      input.organizationId,
      input.repositoryId,
      created.number,
      input.pullRequestId,
      input.pullRequestId ? null : input.branch,
      input.reviewRunId,
      title,
      body,
    ],
  );
}
