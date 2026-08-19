import { cookies } from 'next/headers';
import Link from 'next/link';
import parseDiff from 'parse-diff';
import { GateBadge } from '../../GateBadge';

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
  github_pr_number: number | null;
  pull_request_title: string | null;
  findings: Finding[];
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

function FindingRow({ f }: { f: Finding }) {
  return (
    <li>
      <span className={`badge badge-${f.severity === 'critical' || f.severity === 'high' ? 'high' : f.severity === 'medium' ? 'medium' : 'low'}`}>
        {f.severity.toUpperCase()}
      </span>{' '}
      {f.blocking && <strong className="status-bad">bloqueante</strong>} {f.title} <em>({f.file_path}
      {f.line_start ? `:${f.line_start}` : ''})</em>
      <br />
      {f.explanation}
      {f.violated_rule && (
        <>
          <br />
          <em>Regla incumplida: “{f.violated_rule}”</em>
        </>
      )}
    </li>
  );
}

export default async function ReviewRunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [run, diffResponse] = await Promise.all([
    fetchJson<ReviewRunDetail | null>(`/dashboard/review-runs/${id}`),
    fetchJson<{ diff: string }>(`/dashboard/review-runs/${id}/diff`),
  ]);

  if (!run) {
    return (
      <main>
        <p>Review run no encontrado.</p>
      </main>
    );
  }

  const files = parseDiff(diffResponse.diff ?? '');

  const critical = run.findings.filter((f) => f.severity === 'critical');
  const important = run.findings.filter((f) => f.severity === 'high' || f.severity === 'medium');
  const minor = run.findings.filter((f) => f.severity === 'low' || f.severity === 'info');
  const violatedRules = run.findings.filter((f) => f.violated_rule);

  return (
    <main>
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

      <h1>Hallazgos</h1>
      <div className="card">
        <p>
          <strong>Críticos ({critical.length})</strong>
        </p>
        {critical.length > 0 && (
          <ul>
            {critical.map((f) => (
              <FindingRow key={f.id} f={f} />
            ))}
          </ul>
        )}
        <p>
          <strong>Importantes ({important.length})</strong>
        </p>
        {important.length > 0 && (
          <ul>
            {important.map((f) => (
              <FindingRow key={f.id} f={f} />
            ))}
          </ul>
        )}
        <p>
          <strong>Menores ({minor.length})</strong>
        </p>
        {minor.length > 0 && (
          <ul>
            {minor.map((f) => (
              <FindingRow key={f.id} f={f} />
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
      {files.length === 0 && <p>No se pudo obtener el diff de este commit.</p>}

      {files.map((file, fileIdx) => {
        const filePath = file.to && file.to !== '/dev/null' ? file.to : file.from ?? '(desconocido)';
        const fileFindings = run.findings.filter((f) => f.file_path === filePath);

        return (
          <div key={fileIdx} className="diff-file">
            <div className="diff-file-header">{filePath}</div>
            <table className="diff-table">
              <tbody>
                {file.chunks.map((chunk, chunkIdx) =>
                  chunk.changes.map((change, changeIdx) => {
                    const newLine = change.type === 'add' ? change.ln : change.type === 'normal' ? change.ln2 : undefined;
                    const lineFindings = newLine ? findingsForLine(fileFindings, filePath, newLine) : [];
                    const worstSeverity = lineFindings[0]?.severity;

                    const rowClass = [
                      worstSeverity ? `diff-finding-${worstSeverity}` : change.type === 'add' ? 'diff-add' : change.type === 'del' ? 'diff-del' : '',
                    ]
                      .filter(Boolean)
                      .join(' ');

                    return (
                      <tr key={`${chunkIdx}-${changeIdx}`} className={rowClass || undefined}>
                        <td className="diff-line-num">
                          {change.type === 'add' ? change.ln : change.type === 'normal' ? change.ln2 : ''}
                        </td>
                        <td>
                          {change.type === 'add' ? '+' : change.type === 'del' ? '-' : ' '}
                          {change.content.replace(/^[+-]/, '')}
                        </td>
                      </tr>
                    );
                  }),
                )}
              </tbody>
            </table>

            {fileFindings.length > 0 && (
              <div className="diff-findings-list">
                <h3>Hallazgos en este archivo</h3>
                <ul>
                  {fileFindings.map((f) => (
                    <FindingRow key={f.id} f={f} />
                  ))}
                </ul>
              </div>
            )}
          </div>
        );
      })}
    </main>
  );
}
