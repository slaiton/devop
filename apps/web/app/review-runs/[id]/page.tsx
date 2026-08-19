import { cookies } from 'next/headers';
import Link from 'next/link';
import parseDiff from 'parse-diff';

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
}

interface ReviewRunDetail {
  id: string;
  repository_id: string;
  repository_full_name: string;
  branch: string | null;
  commit_sha: string;
  trigger: 'push' | 'pull_request';
  status: string;
  gate_decision: 'apto' | 'no_apto' | null;
  quality_score: number | null;
  risk_level: 'low' | 'medium' | 'high' | null;
  summary: string | null;
  github_pr_number: number | null;
  pull_request_title: string | null;
  findings: Finding[];
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: '#f8d7da',
  high: '#fde2c8',
  medium: '#fff3cd',
  low: '#d6e9ff',
  info: '#e9ecef',
};

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
  return findings.filter(
    (f) => f.file_path === filePath && f.line_start != null && line >= f.line_start && line <= (f.line_end ?? f.line_start),
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
        Commit <code>{run.commit_sha.slice(0, 7)}</code> —{' '}
        {run.gate_decision === 'apto' ? (
          <span style={{ color: 'green' }}>✓ APTO</span>
        ) : run.gate_decision === 'no_apto' ? (
          <span style={{ color: 'crimson' }}>❌ NO APTO</span>
        ) : (
          <span>{run.status}</span>
        )}
        {' — '}Score: {run.quality_score ?? '-'} — Riesgo: {run.risk_level ?? '-'}
      </p>
      {run.summary && <p>{run.summary}</p>}

      {files.length === 0 && <p>No se pudo obtener el diff de este commit.</p>}

      {files.map((file, fileIdx) => {
        const filePath = file.to && file.to !== '/dev/null' ? file.to : file.from ?? '(desconocido)';
        const fileFindings = run.findings.filter((f) => f.file_path === filePath);

        return (
          <section key={fileIdx} style={{ marginBottom: '1.5rem', border: '1px solid #ccc', borderRadius: 6 }}>
            <div style={{ padding: '0.5rem 0.75rem', background: '#f5f5f5', fontFamily: 'monospace' }}>{filePath}</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'monospace', fontSize: '0.85em' }}>
              <tbody>
                {file.chunks.map((chunk, chunkIdx) =>
                  chunk.changes.map((change, changeIdx) => {
                    const newLine = change.type === 'add' ? change.ln : change.type === 'normal' ? change.ln2 : undefined;
                    const lineFindings = newLine ? findingsForLine(fileFindings, filePath, newLine) : [];
                    const worstBlocking = lineFindings.some((f) => f.blocking);
                    const bg = lineFindings.length
                      ? SEVERITY_COLOR[
                          lineFindings.sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0))[0]
                            .severity
                        ]
                      : change.type === 'add'
                        ? '#eaffea'
                        : change.type === 'del'
                          ? '#ffecec'
                          : undefined;

                    return (
                      <tr key={`${chunkIdx}-${changeIdx}`} style={{ background: bg, borderLeft: worstBlocking ? '3px solid crimson' : undefined }}>
                        <td style={{ width: 40, textAlign: 'right', color: '#888', userSelect: 'none', padding: '0 0.5em' }}>
                          {change.type === 'add' ? change.ln : change.type === 'normal' ? change.ln2 : ''}
                        </td>
                        <td style={{ whiteSpace: 'pre' }}>
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
              <div style={{ padding: '0.75rem' }}>
                <strong>Hallazgos en este archivo</strong>
                <ul>
                  {fileFindings.map((f) => (
                    <li key={f.id}>
                      [{f.severity.toUpperCase()}
                      {f.blocking ? ' — bloqueante' : ''}] {f.title}
                      {f.line_start ? ` (línea ${f.line_start})` : ''}
                      <br />
                      {f.explanation}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        );
      })}
    </main>
  );
}
