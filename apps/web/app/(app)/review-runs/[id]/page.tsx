import { Suspense } from 'react';
import { cookies } from 'next/headers';
import Link from 'next/link';
import parseDiff from 'parse-diff';
import { GateBadge } from '../../../GateBadge';
import { getSession } from '../../../session';
import { AnalysisTrace, type AnalysisStats, type LlmFailover, type TraceEntry } from './AnalysisTrace';
import { ScannerReport, type AuditCoverage, type ScanFindingRow, type ScannerRunRow } from './ScannerReport';
import { TriageReport, type Escalation, type InvocationRow, type Layer2Summary } from './TriageReport';
import { ClarificationThread, type ClarificationMessage } from './ClarificationThread';
import { ReconsiderFindingButton } from './ReconsiderFindingButton';

interface Finding {
  id: string;
  category: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  file_path: string;
  line_start: number | null;
  line_end: number | null;
  title: string;
  explanation: string;
  blocking: boolean;
  violated_rule: string | null;
  status: 'open' | 'fixed' | 'dismissed_false_positive' | 'awaiting_clarification';
  question: string | null;
  needs_human: boolean;
  clarification_round: number;
  resolution_comment: string | null;
  resolved_at: string | null;
}

interface ReviewRunDetail {
  id: string;
  repository_id: string;
  repository_full_name: string;
  branch: string | null;
  commit_sha: string;
  trigger: 'push' | 'pull_request';
  status: string;
  gate_decision: 'apto' | 'requiere_revision' | 'no_apto' | null;
  llm_verdict: 'apto' | 'requiere_revision' | 'no_apto' | null;
  quality_score: number | null;
  risk_level: 'low' | 'medium' | 'high' | null;
  summary: string | null;
  final_justification: string | null;
  commit_history_comparison: string | null;
  recommendations: string[] | null;
  recommended_tests: string[] | null;
  analyzed_files: string[] | null;
  analysis_mode: 'standard' | 'deep' | null;
  analysis_note: string | null;
  analysis_trace: TraceEntry[] | null;
  analysis_stats: AnalysisStats | null;
  llm_provider: string | null;
  llm_model: string | null;
  llm_failovers: LlmFailover[] | null;
  github_pr_number: number | null;
  pull_request_title: string | null;
  findings: Finding[];
  clarifications: ClarificationMessage[];
  audit_stage: string | null;
  audit_coverage: AuditCoverage | null;
  scanner_runs: ScannerRunRow[];
  scan_findings: ScanFindingRow[];
  audit_layer2: Layer2Summary | null;
  audit_escalation: Escalation | null;
  llm_invocations: InvocationRow[];
}

const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

async function fetchJson<T>(path: string): Promise<T> {
  const cookieHeader = cookies().toString();
  const res = await fetch(`${process.env.API_INTERNAL_URL}/api${path}`, {
    headers: { Cookie: cookieHeader },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`failed to load ${path}: ${res.status}`);
  return res.json();
}

function findingsForLine(findings: Finding[], filePath: string, line: number): Finding[] {
  return findings
    .filter(
      (f) => f.file_path === filePath && f.line_start != null && line >= f.line_start && line <= (f.line_end ?? f.line_start),
    )
    .sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0));
}

const FINDING_STATUS_LABEL: Record<Finding['status'], string> = {
  awaiting_clarification: 'pregunta pendiente',
  open: 'abierto',
  fixed: 'corregido',
  dismissed_false_positive: 'falso positivo',
};

function FindingRow({ f, repositoryId, reviewRunId }: { f: Finding; repositoryId: string; reviewRunId: string }) {
  return (
    <li>
      <span className={`badge badge-${f.severity === 'critical' || f.severity === 'high' ? 'high' : f.severity === 'medium' ? 'medium' : 'low'}`}>
        {f.severity.toUpperCase()}
      </span>{' '}
      {f.blocking && <strong className="status-bad">bloqueante</strong>} {f.title} <em>({f.file_path}
      {f.line_start ? `:${f.line_start}` : ''})</em>
      {f.status !== 'open' && (
        <>
          {' '}
          <span className="badge badge-low">{FINDING_STATUS_LABEL[f.status]}</span>
        </>
      )}
      <br />
      {f.explanation}
      {f.violated_rule && (
        <>
          <br />
          <em>Regla incumplida: “{f.violated_rule}”</em>
        </>
      )}
      {f.resolution_comment && (
        <>
          <br />
          <em>Comentario: “{f.resolution_comment}”</em>
        </>
      )}
      {f.status === 'open' && (
        <>
          <br />
          <ReconsiderFindingButton repositoryId={repositoryId} reviewRunId={reviewRunId} findingId={f.id} />
        </>
      )}
    </li>
  );
}

export default async function ReviewRunDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ diff?: string }> }) {
  const { id } = await params;
  const { diff: diffMode } = await searchParams;
  // El diff ya NO bloquea la página: se pide y se pinta aparte (Suspense). Un commit enorme no retrasa el resumen, los hallazgos ni
  // el informe de la auditoría.
  const run = await fetchJson<ReviewRunDetail | null>(`/dashboard/review-runs/${id}`);

  if (!run) {
    return <p>Review run no encontrado.</p>;
  }

  const session = await getSession();
  const isAdmin = session?.role === 'admin';

  // Las preguntas de la IA van aparte: no son hallazgos confirmados y todavía no bloquean.
  const questions = run.findings.filter((f) => f.status === 'awaiting_clarification');
  const confirmed = run.findings.filter((f) => f.status !== 'awaiting_clarification');
  const critical = confirmed.filter((f) => f.severity === 'critical');
  const important = confirmed.filter((f) => f.severity === 'high' || f.severity === 'medium');
  const minor = confirmed.filter((f) => f.severity === 'low' || f.severity === 'info');
  const violatedRules = run.findings.filter((f) => f.violated_rule);

  return (
    <>
      <p>
        <Link href={`/repositories/${run.repository_id}`}>&larr; {run.repository_full_name}</Link>
      </p>

      <h1>
        {run.trigger === 'pull_request'
          ? `PR #${run.github_pr_number}: ${run.pull_request_title ?? ''}`
          : `Push a ${run.branch ?? '-'}`}
      </h1>
      <p>
        Commit <code>{run.commit_sha.slice(0, 7)}</code> — <GateBadge decision={run.gate_decision} />
        {run.llm_verdict && run.llm_verdict !== run.gate_decision && (
          <span className="error-text" style={{ display: 'inline' }}>
            {' '}(el LLM sugirió {run.llm_verdict.replace('_', ' ')}, corregido por regla determinista)
          </span>
        )}
        {' — '}Score: {run.quality_score ?? '-'} — Riesgo:{' '}
        {run.risk_level ? <span className={`badge badge-${run.risk_level}`}>{run.risk_level}</span> : '-'}
      </p>
      {run.summary && <p>{run.summary}</p>}

      <AnalysisTrace mode={run.analysis_mode} note={run.analysis_note} trace={run.analysis_trace} stats={run.analysis_stats}
        llmProvider={run.llm_provider}
        llmModel={run.llm_model}
        llmFailovers={run.llm_failovers}
      />

      <ScannerReport runs={run.scanner_runs} findings={run.scan_findings} coverage={run.audit_coverage} stage={run.audit_stage} />

      <TriageReport layer2={run.audit_layer2} escalation={run.audit_escalation} invocations={run.llm_invocations} />

      {run.analyzed_files && run.analyzed_files.length > 0 && (
        <>
          <h1>Archivos analizados</h1>
          <div className="card-row">
            {run.analyzed_files.map((f) => (
              <code key={f}>{f}</code>
            ))}
          </div>
        </>
      )}

      {questions.length > 0 && (
        <>
          <h1>
            Preguntas de la IA ({questions.length})
          </h1>
          <p style={{ color: 'var(--ink-muted)' }}>
            La IA no pudo comprobar estos puntos con lo que ve en el commit. <strong>No bloquean todavía</strong>: responde (o indica qué
            repositorio revisar) y los reevalúa antes de decidir si son bloqueantes.
          </p>
          <div className="qa-list">
            {questions.map((q) => (
              <ClarificationThread
                key={q.id}
                finding={q}
                messages={run.clarifications.filter((m) => m.finding_id === q.id)}
                isAdmin={isAdmin}
                canAnswer
              />
            ))}
          </div>
        </>
      )}

      <h1>Hallazgos</h1>
      <div className="card">
        <p>
          <strong>Críticos ({critical.length})</strong>
        </p>
        {critical.length > 0 && (
          <ul>
            {critical.map((f) => (
              <FindingRow key={f.id} f={f} repositoryId={run.repository_id} reviewRunId={run.id} />
            ))}
          </ul>
        )}
        <p>
          <strong>Importantes ({important.length})</strong>
        </p>
        {important.length > 0 && (
          <ul>
            {important.map((f) => (
              <FindingRow key={f.id} f={f} repositoryId={run.repository_id} reviewRunId={run.id} />
            ))}
          </ul>
        )}
        <p>
          <strong>Menores ({minor.length})</strong>
        </p>
        {minor.length > 0 && (
          <ul>
            {minor.map((f) => (
              <FindingRow key={f.id} f={f} repositoryId={run.repository_id} reviewRunId={run.id} />
            ))}
          </ul>
        )}
      </div>

      {violatedRules.length > 0 && (
        <>
          <h1>Reglas incumplidas</h1>
          <div className="card">
            <ul>
              {violatedRules.map((f) => (
                <li key={f.id}>
                  “{f.violated_rule}” — {f.file_path}
                  {f.line_start ? `:${f.line_start}` : ''}: {f.title}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {run.recommendations && run.recommendations.length > 0 && (
        <>
          <h1>Recomendaciones</h1>
          <div className="card">
            <ul>
              {run.recommendations.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        </>
      )}

      {run.recommended_tests && run.recommended_tests.length > 0 && (
        <>
          <h1>Tests recomendados</h1>
          <div className="card">
            <ul>
              {run.recommended_tests.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          </div>
        </>
      )}

      {run.commit_history_comparison && (
        <>
          <h1>Comparación con commits previos</h1>
          <p>{run.commit_history_comparison}</p>
        </>
      )}

      {run.final_justification && (
        <>
          <h1>Justificación final</h1>
          <p>{run.final_justification}</p>
        </>
      )}

      <h1>Diff</h1>
      <Suspense fallback={<p className="scan-note" role="status">Cargando el diff…</p>}>
        <DiffSection run={run} showAll={diffMode === 'all'} />
      </Suspense>
    </>
  );
}

/** Lo que se pinta por defecto del diff: un commit enorme (lockfiles, código generado, cientos de archivos) generaba cientos de miles de
 * nodos y volvía lenta la página. Con `?diff=all` se muestra mucho más (con tope). Los archivos con hallazgos siempre se muestran. */
const DIFF_LIMITS = {
  default: { files: 60, lines: 4000, perFile: 600 },
  all: { files: 400, lines: 40000, perFile: 5000 },
};

/** Debe mantenerse igual que `isLowValueFile` del worker (apps/worker/src/modules/review/inputBudget.ts). */
function isLowValueFile(path: string): boolean {
  const p = path.toLowerCase();
  const name = p.split('/').pop() ?? p;
  return (
    /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|gemfile\.lock|go\.sum|poetry\.lock|pipfile\.lock|uv\.lock|cargo\.lock|packages\.lock\.json|mix\.lock|pubspec\.lock|podfile\.lock|gradle\.lockfile)$/.test(p) ||
    /\.(lock|min\.js|min\.css|map|snap|svg|png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|eot|zip|gz|tgz|jar|class|exe|dll|so|bin|mp4|mov)$/.test(name) ||
    /(^|\/)(node_modules|vendor|dist|build|\.next|__snapshots__|coverage|\.yarn)\//.test(p) ||
    /(\.generated\.|_pb2\.py$|\.pb\.go$|\.g\.dart$|\.designer\.cs$)/.test(name)
  );
}

interface DiffResponse {
  diff: string;
  truncated?: boolean;
  totalChars?: number;
  omittedFiles?: string[];
}

async function DiffSection({ run, showAll }: { run: ReviewRunDetail; showAll: boolean }) {
  let response: DiffResponse;
  try {
    response = await fetchJson<DiffResponse>(`/dashboard/review-runs/${run.id}/diff`);
  } catch {
    return <p>No se pudo obtener el diff de este commit.</p>;
  }
  const files = parseDiff(typeof response.diff === 'string' ? response.diff : '');
  if (files.length === 0) return <p>No se pudo obtener el diff de este commit.</p>;

  const limits = showAll ? DIFF_LIMITS.all : DIFF_LIMITS.default;
  const githubUrl = `https://github.com/${run.repository_full_name}/commit/${run.commit_sha}`;
  const pathOf = (file: (typeof files)[number]) => (file.to && file.to !== '/dev/null' ? file.to : file.from ?? '(desconocido)');
  const totalLines = files.reduce((n, f) => n + f.additions + f.deletions, 0);
  const findingPaths = new Set(run.findings.map((f) => f.file_path));

  // Qué archivos se pintan completos, cuáles colapsados y cuáles quedan fuera (siempre se pintan los que tienen hallazgos).
  let budget = limits.lines;
  let shown = 0;
  const plan = files.map((file) => {
    const path = pathOf(file);
    const lines = file.additions + file.deletions;
    const withFindings = findingPaths.has(path);
    const lowValue = isLowValueFile(path) && !withFindings;
    let mode: 'full' | 'collapsed' | 'omitted' = 'full';
    if (lowValue) mode = 'collapsed';
    else if (!withFindings && (shown >= limits.files || budget <= 0)) mode = 'omitted';
    if (mode === 'full') {
      shown += 1;
      budget -= Math.min(lines, limits.perFile);
    }
    return { file, path, lines, mode };
  });
  const omitted = plan.filter((x) => x.mode === 'omitted');
  const collapsed = plan.filter((x) => x.mode === 'collapsed');
  const trimmedByApi = response.truncated === true;

  return (
    <>
      <p className="scan-note">
        {trimmedByApi
          ? `El commit modifica ${(files.length + (response.omittedFiles?.length ?? 0)).toLocaleString('es')} archivo(s); aquí se cargaron ${files.length} (${totalLines.toLocaleString('es')} líneas cambiadas)`
          : `${files.length} archivo(s) modificado(s) · ${totalLines.toLocaleString('es')} líneas cambiadas`}
        {omitted.length + collapsed.length > 0 && !showAll && (
          <>
            {' '}
            · se muestran completos {plan.filter((x) => x.mode === 'full').length}
            {collapsed.length > 0 ? `; ${collapsed.length} de bajo valor (lockfiles, generados) están colapsados` : ''}
            {omitted.length > 0 ? `; ${omitted.length} no se muestran por el tamaño del cambio` : ''}.{' '}
            <Link href={`/review-runs/${run.id}?diff=all`}>Ver mucho más del diff</Link>
          </>
        )}
        {showAll && (
          <>
            {' '}
            · <Link href={`/review-runs/${run.id}`}>Volver a la vista resumida</Link>
          </>
        )}{' '}
        · <a href={githubUrl} target="_blank" rel="noreferrer">Verlo completo en GitHub</a>
      </p>
      {trimmedByApi && (
        <p className="scan-banner scan-banner-warn" role="status">
          El diff completo pesa {((response.totalChars ?? 0) / 1048576).toFixed(1)} MB y se recortó para mostrarlo
          {response.omittedFiles && response.omittedFiles.length > 0
            ? `: no se incluyen ${response.omittedFiles.length} archivo(s) (${response.omittedFiles.slice(0, 40).join(', ')}${response.omittedFiles.length > 40 ? '…' : ''})`
            : ''}
          . Los archivos con hallazgos siempre se incluyen. Ábrelo en GitHub para verlo entero.
        </p>
      )}

      {plan.map(({ file, path, lines, mode }, fileIdx) => {
        if (mode === 'omitted') return null;
        if (mode === 'collapsed') {
          return (
            <div key={fileIdx} className="diff-file">
              <div className="diff-file-header">
                {path} <span className="scan-note">— {lines.toLocaleString('es')} líneas · archivo de bajo valor (lockfile, generado o de recursos): no se muestra</span>
              </div>
            </div>
          );
        }
        const fileFindings = run.findings.filter((f) => f.file_path === path);
        let rendered = 0;
        const rows: React.ReactElement[] = [];
        for (let chunkIdx = 0; chunkIdx < file.chunks.length && rendered < limits.perFile; chunkIdx++) {
          const chunk = file.chunks[chunkIdx];
          for (let changeIdx = 0; changeIdx < chunk.changes.length && rendered < limits.perFile; changeIdx++) {
            const change = chunk.changes[changeIdx];
            rendered += 1;
            const newLine = change.type === 'add' ? change.ln : change.type === 'normal' ? change.ln2 : undefined;
            const lineFindings = newLine && fileFindings.length > 0 ? findingsForLine(fileFindings, path, newLine) : [];
            const worstSeverity = lineFindings[0]?.severity;
            const rowClass = worstSeverity ? `diff-finding-${worstSeverity}` : change.type === 'add' ? 'diff-add' : change.type === 'del' ? 'diff-del' : '';
            rows.push(
              <tr key={`${chunkIdx}-${changeIdx}`} className={rowClass || undefined}>
                <td className="diff-line-num">{change.type === 'add' ? change.ln : change.type === 'normal' ? change.ln2 : ''}</td>
                <td>
                  {change.type === 'add' ? '+' : change.type === 'del' ? '-' : ' '}
                  {change.content.replace(/^[+-]/, '')}
                </td>
              </tr>,
            );
          }
        }
        const totalChanges = file.chunks.reduce((n, c) => n + c.changes.length, 0);

        return (
          <div key={fileIdx} className="diff-file">
            <div className="diff-file-header">{path}</div>
            <table className="diff-table">
              <tbody>{rows}</tbody>
            </table>
            {totalChanges > rendered && (
              <p className="scan-note">
                … {(totalChanges - rendered).toLocaleString('es')} líneas más en este archivo.{' '}
                {!showAll && <Link href={`/review-runs/${run.id}?diff=all`}>Ver más</Link>}
              </p>
            )}

            {fileFindings.length > 0 && (
              <div className="diff-findings-list">
                <h3>Hallazgos en este archivo</h3>
                <ul>
                  {fileFindings.map((f) => (
                    <FindingRow key={f.id} f={f} repositoryId={run.repository_id} reviewRunId={run.id} />
                  ))}
                </ul>
              </div>
            )}
          </div>
        );
      })}

      {omitted.length > 0 && (
        <p className="scan-note">
          Archivos que no se muestran ({omitted.length}): {omitted.slice(0, 40).map((x) => x.path).join(', ')}
          {omitted.length > 40 ? '…' : ''}
        </p>
      )}
    </>
  );
}
