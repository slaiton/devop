import type { GitProviderPort } from '@devsentinel/git-providers';
import { buildIssueContent, commitLinkMd, type IssueContentFinding, type IssueContentReviewRun } from './buildIssueContent';

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
  /** 'push': hay un commit nuevo real que se puede citar como el que resolvió/introdujo
   * hallazgos. 'reconsideration': no hay commit nuevo — un humano reconsideró un
   * hallazgo sobre el mismo commit ya analizado; el cierre se documenta con
   * `resolutionContext` en vez de un link a commit. */
  trigger: 'push' | 'reconsideration';
  /** Solo relevante con trigger='reconsideration': el comentario humano + la
   * justificación del LLM, para que el cierre quede documentado igual de bien que uno
   * disparado por push. */
  resolutionContext?: string;
}

interface ExistingIssueRow {
  id: string;
  github_issue_number: number;
  state: 'open' | 'closed';
  review_run_id: string | null;
  first_commit_sha: string | null;
}

/** Crea/actualiza/cierra el issue "de hallazgos bloqueantes" de un PR (o branch,
 * cuando no hay PR) a partir del estado actual de `findings` para ese review run — un
 * único issue por PR/branch, nunca duplicado (índice único parcial `issues_findings_*`
 * como red de seguridad final). Se llama tanto tras un análisis nuevo como tras una
 * reconsideración, siempre, porque también debe cerrar el issue cuando ya no queden
 * bloqueantes. `client` debe venir de una transacción `withTenant` ya abierta.
 *
 * `first_commit_sha` se fija una sola vez al crear el issue y nunca se pisa — es el
 * amarre "al commit inicial" que originó el issue. Los comentarios de cierre/reapertura
 * documentan explícitamente qué hallazgos cambiaron y, si aplica, qué commit lo hizo. */
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
    `SELECT id, github_issue_number, state, review_run_id, first_commit_sha FROM issues
     WHERE repository_id = $1 AND kind = 'findings'
       AND (($2::uuid IS NOT NULL AND pull_request_id = $2) OR ($2::uuid IS NULL AND branch = $3))
     FOR UPDATE`,
    [input.repositoryId, input.pullRequestId, input.branch],
  );
  const existing: ExistingIssueRow | undefined = existingRows[0];

  if (blockingFindings.length === 0) {
    if (existing && existing.state === 'open') {
      // Hallazgos que estaban vigentes en el último análisis reflejado en el issue —
      // para poder decir explícitamente cuáles se resolvieron, no solo "ya no hay".
      const { rows: previousFindingRows } = existing.review_run_id
        ? await client.query(
            `SELECT title FROM findings WHERE review_run_id = $1 AND status = 'open' AND blocking = true`,
            [existing.review_run_id],
          )
        : { rows: [] as { title: string }[] };
      const resolvedTitles: string[] = previousFindingRows.map((f) => f.title);

      const closeComment =
        input.trigger === 'reconsideration'
          ? `✅ Reconsiderado manualmente${input.resolutionContext ? ` — ${input.resolutionContext}` : ''}. Ya no quedan hallazgos bloqueantes vigentes.\n\nCerrando automáticamente.`
          : [
              `✅ El commit ${commitLinkMd(input.repositoryFullName, input.commitSha)} ya no presenta hallazgos bloqueantes vigentes${resolvedTitles.length ? ':' : '.'}`,
              ...resolvedTitles.map((t) => `- ${t}`),
              '',
              'Cerrando automáticamente.',
            ].join('\n');

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
        body: closeComment,
      });
      await client.query(
        `UPDATE issues
         SET state = 'closed', closed_at = now(), updated_at = now(), last_synced_at = now(),
             last_commit_sha = $1, resolved_commit_sha = $2, resolved_via = $3
         WHERE id = $4`,
        [input.commitSha, input.trigger === 'push' ? input.commitSha : null, input.trigger, existing.id],
      );
    }
    return;
  }

  const firstCommitSha = existing?.first_commit_sha ?? input.commitSha;

  const { title, body } = buildIssueContent({
    repositoryFullName: input.repositoryFullName,
    pullRequestNumber: input.pullRequestNumber,
    branch: input.branch,
    firstCommitSha,
    lastCommitSha: input.commitSha,
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
        body: [
          `⚠️ Reabriendo — el commit ${commitLinkMd(input.repositoryFullName, input.commitSha)} introduce nuevos hallazgos bloqueantes:`,
          ...blockingFindings.map((f) => `- ${f.title}`),
        ].join('\n'),
      });
    }
    await client.query(
      `UPDATE issues
       SET title = $1, body = $2, review_run_id = $3, state = 'open', closed_at = NULL, updated_at = now(),
           last_synced_at = now(), last_commit_sha = $4, resolved_commit_sha = NULL, resolved_via = NULL
       WHERE id = $5`,
      [title, body, input.reviewRunId, input.commitSha, existing.id],
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
        kind, origin, title, body, state, first_commit_sha, last_commit_sha)
     VALUES ($1, $2, $3, $4, $5, $6, 'findings', 'devsentinel', $7, $8, 'open', $9, $9)
     ON CONFLICT (repository_id, github_issue_number) DO UPDATE SET
       pull_request_id = $4, branch = $5, review_run_id = $6, kind = 'findings', origin = 'devsentinel',
       title = $7, body = $8, state = 'open', closed_at = NULL, updated_at = now(), last_synced_at = now(),
       first_commit_sha = COALESCE(issues.first_commit_sha, $9), last_commit_sha = $9`,
    [
      input.organizationId,
      input.repositoryId,
      created.number,
      input.pullRequestId,
      input.pullRequestId ? null : input.branch,
      input.reviewRunId,
      title,
      body,
      input.commitSha,
    ],
  );
}
