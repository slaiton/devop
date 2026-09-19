import { cookies } from 'next/headers';
import Link from 'next/link';
import { NotifyButton } from './NotifyButton';
import { CreatePullRequestButton } from './PullRequestActions';
import { MarkReviewedButton } from './MarkReviewedButton';
import { CreateIssueButton } from './CreateIssueButton';
import { GateBadge } from '../../../GateBadge';
import { getSession } from '../../../session';

interface PushRow {
  id: string;
  commit_sha: string;
  branch: string | null;
  status: string;
  quality_score: number | null;
  risk_level: 'low' | 'medium' | 'high' | null;
  gate_decision: 'apto' | 'requiere_revision' | 'no_apto' | null;
  blocking_count: number;
  author_name: string | null;
  author_email: string | null;
  notified_at: string | null;
  reviewed_at: string | null;
  started_at: string;
}

interface PushesPage {
  items: PushRow[];
  total: number;
  page: number;
  pageSize: number;
}

function isEligibleForPullRequest(run: Pick<PushRow, 'gate_decision' | 'risk_level' | 'quality_score'>): boolean {
  if (run.gate_decision === 'no_apto') return false;
  return run.gate_decision === 'apto' || (run.risk_level === 'medium' && (run.quality_score ?? 100) <= 70);
}

async function fetchJson<T>(path: string): Promise<T> {
  const cookieHeader = cookies().toString();
  const res = await fetch(`${process.env.API_INTERNAL_URL}/api${path}`, {
    headers: { Cookie: cookieHeader },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`failed to load ${path}: ${res.status}`);
  return res.json();
}

export default async function RepositoryPushesTab({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const session = await getSession();
  const isAdmin = session?.role === 'admin';
  const { id } = await params;
  const { page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);

  let pushesPage: PushesPage;
  try {
    pushesPage = await fetchJson<PushesPage>(`/dashboard/repositories/${id}/pushes?page=${page}&pageSize=20`);
  } catch {
    return <p>No se pudieron cargar los pushes de este repositorio.</p>;
  }

  const { items: pushes, total, pageSize } = pushesPage;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      {pushes.length === 0 ? (
        <p>Todavía no hay pushes analizados en las ramas monitoreadas.</p>
      ) : (
        <div>
          {pushes.map((run) => (
            <div key={run.id} className="card">
              <p>
                <strong>{run.branch ?? '-'}</strong> — commit{' '}
                <Link href={`/review-runs/${run.id}`}>{run.commit_sha.slice(0, 7)}</Link> —{' '}
                {new Date(run.started_at).toLocaleString()}
              </p>
              <p>
                {run.status !== 'completed' ? (
                  <span>Estado: {run.status}</span>
                ) : (
                  <>
                    <GateBadge decision={run.gate_decision} />
                    {run.gate_decision === 'no_apto' && ` — ${run.blocking_count} hallazgo(s) bloqueante(s)`}
                  </>
                )}
                {' — '}
                Score: {run.quality_score ?? '-'} — Riesgo:{' '}
                {run.risk_level ? <span className={`badge badge-${run.risk_level}`}>{run.risk_level}</span> : '-'}
              </p>
              {run.notified_at && <p>✉️ Notificado el {new Date(run.notified_at).toLocaleString()}</p>}
              {run.reviewed_at ? (
                <p className="status-ok">✓ Revisado el {new Date(run.reviewed_at).toLocaleString()}</p>
              ) : (
                isAdmin && (
                  <div className="card-row">
                    {run.author_email && !run.notified_at && (
                      <NotifyButton repositoryId={id} reviewRunId={run.id} authorEmail={run.author_email} />
                    )}
                    {isEligibleForPullRequest(run) && <CreatePullRequestButton repositoryId={id} reviewRunId={run.id} />}
                    <MarkReviewedButton repositoryId={id} reviewRunId={run.id} />
                    {run.gate_decision === 'no_apto' && <CreateIssueButton repositoryId={id} reviewRunId={run.id} />}
                  </div>
                )
              )}
            </div>
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="pagination">
          {page > 1 ? <Link href={`/repositories/${id}?page=${page - 1}`}>&larr; Anterior</Link> : <span>&larr; Anterior</span>}
          <span>
            Página {page} de {totalPages} ({total} pushes)
          </span>
          {page < totalPages ? (
            <Link href={`/repositories/${id}?page=${page + 1}`}>Siguiente &rarr;</Link>
          ) : (
            <span>Siguiente &rarr;</span>
          )}
        </div>
      )}
    </>
  );
}
