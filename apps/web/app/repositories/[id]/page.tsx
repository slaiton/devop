import { cookies } from 'next/headers';
import Link from 'next/link';
import { MergeButton } from './MergeButton';

interface PullRequestRow {
  id: string;
  github_pr_number: number;
  title: string;
  status: 'open' | 'merged' | 'closed';
  author_login: string;
  source_branch: string;
  target_branch: string;
  quality_score: number | null;
  risk_level: 'low' | 'medium' | 'high' | null;
  review_status: string | null;
}

interface PushRow {
  id: string;
  commit_sha: string;
  status: string;
  quality_score: number | null;
  risk_level: 'low' | 'medium' | 'high' | null;
  started_at: string;
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

export default async function RepositoryPullRequestsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [pullRequests, pushes] = await Promise.all([
    fetchJson<PullRequestRow[]>(`/dashboard/repositories/${id}/pull-requests`),
    fetchJson<PushRow[]>(`/dashboard/repositories/${id}/pushes`),
  ]);

  return (
    <main>
      <p>
        <Link href="/">&larr; Repositorios</Link>
      </p>

      <h1>Pull requests</h1>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Título</th>
            <th>Autor</th>
            <th>Rama</th>
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
              <td>{pr.title}</td>
              <td>{pr.author_login}</td>
              <td>{pr.source_branch} → {pr.target_branch}</td>
              <td>{pr.quality_score ?? '-'}</td>
              <td>{pr.risk_level ? <span className={`badge badge-${pr.risk_level}`}>{pr.risk_level}</span> : '-'}</td>
              <td>{pr.status === 'open' ? (pr.review_status ?? 'pendiente') : pr.status}</td>
              <td>
                {pr.status === 'open' && (
                  <MergeButton
                    repositoryId={id}
                    pullRequestId={pr.id}
                    prNumber={pr.github_pr_number}
                    riskLevel={pr.risk_level}
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h1>Pushes</h1>
      <table>
        <thead>
          <tr>
            <th>Commit</th>
            <th>Score</th>
            <th>Riesgo</th>
            <th>Estado</th>
            <th>Fecha</th>
          </tr>
        </thead>
        <tbody>
          {pushes.map((run) => (
            <tr key={run.id}>
              <td>{run.commit_sha.slice(0, 7)}</td>
              <td>{run.quality_score ?? '-'}</td>
              <td>{run.risk_level ? <span className={`badge badge-${run.risk_level}`}>{run.risk_level}</span> : '-'}</td>
              <td>{run.status}</td>
              <td>{new Date(run.started_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
