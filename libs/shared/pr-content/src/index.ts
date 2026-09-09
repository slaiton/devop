export interface PrContentReviewRun {
  gate_decision: 'apto' | 'requiere_revision' | 'no_apto' | null;
  quality_score: number | null;
  risk_level: 'low' | 'medium' | 'high' | null;
  summary: string | null;
}

export interface PrContentFinding {
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  category: string;
  file_path: string;
  line_start: number | null;
  title: string;
  explanation: string;
  blocking: boolean;
  violated_rule: string | null;
}

export interface BuildPullRequestContentInput {
  repositoryFullName: string;
  branch: string;
  commitSha: string;
  reviewRun: PrContentReviewRun;
  findings: PrContentFinding[];
}

const SEVERITY_ORDER: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

const GATE_LABEL: Record<string, string> = {
  apto: '✓ APTO',
  requiere_revision: '⚠ REQUIERE REVISIÓN',
  no_apto: '❌ NO APTO',
};

/** Genera título y descripción de un Pull Request a partir de un análisis ya
 * existente (no vuelve a llamar al LLM) — usado tanto por el botón manual (api) como
 * por la creación automática (worker), para no duplicar el formato entre procesos. */
export function buildPullRequestContent(input: BuildPullRequestContentInput): { title: string; body: string } {
  const { repositoryFullName, branch, commitSha, reviewRun, findings } = input;
  const shortSha = commitSha.slice(0, 7);
  const gateLabel = reviewRun.gate_decision ? GATE_LABEL[reviewRun.gate_decision] : 'sin veredicto';

  const title = `[DevSentinel AI] ${branch} @ ${shortSha} — ${gateLabel}`;

  const sorted = [...findings].sort((a, b) => (SEVERITY_ORDER[b.severity] ?? 0) - (SEVERITY_ORDER[a.severity] ?? 0));
  const findingsMd = sorted.length
    ? sorted
        .map(
          (f) =>
            `- **[${f.severity.toUpperCase()}${f.blocking ? ' — bloqueante' : ''}] ${f.title}** (${f.file_path}${f.line_start ? `:${f.line_start}` : ''})\n  ${f.explanation}${f.violated_rule ? `\n  _Regla incumplida: "${f.violated_rule}"_` : ''}`,
        )
        .join('\n')
    : '_Sin hallazgos._';

  const body = [
    `### DevSentinel AI — análisis de \`${repositoryFullName}@${shortSha}\``,
    '',
    `**Resultado:** ${gateLabel}`,
    `**Score:** ${reviewRun.quality_score ?? '-'}/100 — **Riesgo:** ${reviewRun.risk_level ?? '-'}`,
    '',
    reviewRun.summary ?? '',
    '',
    '#### Hallazgos',
    findingsMd,
    '',
    '---',
    `_Pull Request generado automáticamente por DevSentinel AI a partir del análisis del push \`${shortSha}\` en \`${branch}\`._`,
  ].join('\n');

  return { title, body };
}
