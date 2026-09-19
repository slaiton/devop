import { cookies } from 'next/headers';
import Link from 'next/link';
import { MergePullRequestButton } from '../PullRequestActions';
import { GateBadge } from '../../../../GateBadge';
import { getSession } from '../../../../session';

interface PullRequestRow {
  id: string;
  github_pr_number: number;
  title: string;
  author_login: string;
  source_branch: string;
  target_branch: string;
  status: 'open' | 'merged' | 'closed';
  created_by: 'github' | 'devsentinel';
  source_review_run_id: string | null;
  quality_score: number | null;
  risk_level: 'low' | 'medium' | 'high' | null;
  gate_decision: 'apto' | 'requiere_revision' | 'no_apto' | null;
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

export default async function RepositoryPullRequestsTab({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  const isAdmin = session?.role === 'admin';
  const { id } = await params;

  let pullRequests: PullRequestRow[];
  try {
    pullRequests = await fetchJson<PullRequestRow[]>(`/pull-requests/repository/${id}`);
  } catch {
    return <p>No se pudieron cargar los pull requests de este repositorio.</p>;
  }

  if (pullRequests.length === 0) {
    return <p>Todavía no hay Pull Requests para este repositorio.</p>;
  }

  return (
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Título</th>
          <th>Autor</th>
          <th>Rama</th>
          <th>Origen</th>
          <th>Score</th>
          <th>Riesgo</th>
          <th>Estado</th>
          <th>Acciones</th>
        </tr>
      </thead>
      <tbody>
        {pullRequests.map((pr) => (
          <tr key={pr.id}>
            <td>{pr.github_pr_number}</td>
            <td>
              {pr.source_review_run_id ? <Link href={`/review-runs/${pr.source_review_run_id}`}>{pr.title}</Link> : pr.title}
            </td>
            <td>{pr.author_login}</td>
            <td>
              {pr.source_branch} → {pr.target_branch}
            </td>
            <td>{pr.created_by === 'devsentinel' ? 'DevSentinel' : 'GitHub'}</td>
            <td>{pr.quality_score ?? '-'}</td>
            <td>{pr.risk_level ? <span className={`badge badge-${pr.risk_level}`}>{pr.risk_level}</span> : '-'}</td>
            <td>{pr.status === 'open' ? <GateBadge decision={pr.gate_decision} /> : pr.status}</td>
            <td>{isAdmin && pr.status === 'open' && <MergePullRequestButton pullRequestId={pr.id} />}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
