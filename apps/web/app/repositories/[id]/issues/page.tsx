import { cookies } from 'next/headers';
import Link from 'next/link';
import { SyncIssuesButton } from '../SyncIssuesButton';
import { getSession } from '../../../session';

interface IssueRow {
  id: string;
  github_issue_number: number;
  pull_request_id: string | null;
  branch: string | null;
  kind: 'findings' | 'manual';
  origin: 'github' | 'devsentinel';
  title: string;
  state: 'open' | 'closed';
  author_login: string | null;
  updated_at: string;
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

export default async function RepositoryIssuesTab({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  const isAdmin = session?.role === 'admin';
  const { id } = await params;

  let issues: IssueRow[];
  try {
    issues = await fetchJson<IssueRow[]>(`/issues/repository/${id}`);
  } catch {
    return <p>No se pudieron cargar los issues de este repositorio.</p>;
  }

  return (
    <>
      {isAdmin && <SyncIssuesButton repositoryId={id} />}
      {issues.length === 0 ? (
        <p>Todavía no hay issues sincronizados de este repositorio.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Título</th>
              <th>Origen</th>
              <th>Estado</th>
              <th>Actualizado</th>
            </tr>
          </thead>
          <tbody>
            {issues.map((issue) => (
              <tr key={issue.id}>
                <td>{issue.github_issue_number}</td>
                <td>
                  <Link href={`/repositories/${id}/issues/${issue.id}`}>{issue.title}</Link>
                </td>
                <td>{issue.origin === 'devsentinel' ? 'DevSentinel' : 'GitHub'}</td>
                <td>
                  <span className={issue.state === 'open' ? 'status-ok' : 'status-bad'}>
                    {issue.state === 'open' ? 'Abierto' : 'Cerrado'}
                  </span>
                </td>
                <td>{new Date(issue.updated_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
