import { cookies } from 'next/headers';
import Link from 'next/link';

interface PullRequestRow {
  id: string;
  github_pr_number: number;
  title: string;
  status: string;
  author_login: string;
  quality_score: number | null;
  risk_level: 'low' | 'medium' | 'high' | null;
  review_status: string | null;
}

async function fetchPullRequests(repositoryId: string): Promise<PullRequestRow[]> {
  const cookieHeader = cookies().toString();
  const res = await fetch(`${process.env.API_INTERNAL_URL}/api/dashboard/repositories/${repositoryId}/pull-requests`, {
    headers: { Cookie: cookieHeader },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`failed to load pull requests: ${res.status}`);
  return res.json();
}

export default async function RepositoryPullRequestsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pullRequests = await fetchPullRequests(id);

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
            <th>Score</th>
            <th>Riesgo</th>
            <th>Estado</th>
          </tr>
        </thead>
        <tbody>
          {pullRequests.map((pr) => (
            <tr key={pr.id}>
              <td>{pr.github_pr_number}</td>
              <td>{pr.title}</td>
              <td>{pr.author_login}</td>
              <td>{pr.quality_score ?? '-'}</td>
              <td>{pr.risk_level ? <span className={`badge badge-${pr.risk_level}`}>{pr.risk_level}</span> : '-'}</td>
              <td>{pr.review_status ?? 'pendiente'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
