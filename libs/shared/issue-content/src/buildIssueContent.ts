export interface IssueContentReviewRun {
  gate_decision: 'apto' | 'requiere_revision' | 'no_apto' | null;
  quality_score: number | null;
  risk_level: 'low' | 'medium' | 'high' | null;
  summary: string | null;
}

export interface IssueContentFinding {
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  category: string;
  file_path: string;
  line_start: number | null;
  title: string;
  explanation: string;
  violated_rule: string | null;
}

export interface BuildIssueContentInput {
  repositoryFullName: string;
  pullRequestNumber: number | null;
  branch: string;
  firstCommitSha: string;
  lastCommitSha: string;
  reviewRun: IssueContentReviewRun;
  blockingFindings: IssueContentFinding[];
  reviewRunId: string;
}

const SEVERITY_ORDER: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

/** Marcador invisible al final del body — permite al backfill (sincronizar issues ya
 * existentes) reconocer retroactivamente issues que DevSentinel ya había creado antes
 * de que existiera esta tabla, en vez de asumir que son manuales. */
function issueMarker(reviewRunId: string): string {
  return `<!-- devsentinel:review_run=${reviewRunId} -->`;
}

export function parseReviewRunIdFromIssueBody(body: string | null | undefined): string | null {
  if (!body) return null;
  const match = body.match(/<!-- devsentinel:review_run=([0-9a-f-]{36}) -->/i);
  return match ? match[1] : null;
}

/** Link en Markdown a un commit — no requiere llamar a la API de GitHub, la URL de un
 * commit es determinística a partir del nombre del repo y el SHA. */
export function commitLinkMd(repositoryFullName: string, commitSha: string): string {
  const shortSha = commitSha.slice(0, 7);
  return `[\`${shortSha}\`](https://github.com/${repositoryFullName}/commit/${commitSha})`;
}

/** Genera título y descripción del issue de hallazgos bloqueantes de un PR/branch a
 * partir de un análisis ya existente (no vuelve a llamar al LLM) — mismo criterio que
 * `buildPullRequestContent` en `@devsentinel/pr-content`, pero solo con los findings
 * `blocking` vigentes (el llamador ya filtró por `status = 'open' AND blocking = true`).
 *
 * El título es ESTABLE (no incluye el commit): si cambiara en cada push, GitHub
 * registraría un evento "renamed this issue" en cada sincronización, ensuciando el
 * historial. El commit inicial (que originó el issue) y el último analizado van en el
 * body, que sí se espera que cambie. */
export function buildIssueContent(input: BuildIssueContentInput): { title: string; body: string } {
  const { repositoryFullName, pullRequestNumber, branch, firstCommitSha, lastCommitSha, reviewRun, blockingFindings, reviewRunId } =
    input;
  const target = pullRequestNumber ? `PR #${pullRequestNumber}` : `\`${branch}\``;

  const title = `[DevSentinel AI] Hallazgos bloqueantes en ${target}`;

  const sorted = [...blockingFindings].sort(
    (a, b) => (SEVERITY_ORDER[b.severity] ?? 0) - (SEVERITY_ORDER[a.severity] ?? 0),
  );
  const findingsMd = sorted.length
    ? sorted
        .map(
          (f) =>
            `- **[${f.severity.toUpperCase()}] ${f.title}** (${f.file_path}${f.line_start ? `:${f.line_start}` : ''})\n  ${f.explanation}${f.violated_rule ? `\n  _Regla incumplida: "${f.violated_rule}"_` : ''}`,
        )
        .join('\n')
    : '_Sin hallazgos bloqueantes vigentes._';

  const commitLine =
    firstCommitSha === lastCommitSha
      ? `**Detectado en:** ${commitLinkMd(repositoryFullName, firstCommitSha)}`
      : `**Detectado por primera vez en:** ${commitLinkMd(repositoryFullName, firstCommitSha)} — **último análisis:** ${commitLinkMd(repositoryFullName, lastCommitSha)}`;

  const body = [
    `### DevSentinel AI — hallazgos bloqueantes en \`${repositoryFullName}\` (${target})`,
    '',
    commitLine,
    '',
    `**Score:** ${reviewRun.quality_score ?? '-'}/100 — **Riesgo:** ${reviewRun.risk_level ?? '-'}`,
    '',
    reviewRun.summary ?? '',
    '',
    '#### Hallazgos bloqueantes',
    findingsMd,
    '',
    '---',
    `_Este issue lo gestiona DevSentinel AI automáticamente: se actualiza en cada push/reconsideración de ${target} y se cierra solo cuando ya no queden hallazgos bloqueantes._`,
    issueMarker(reviewRunId),
  ].join('\n');

  return { title, body };
}
