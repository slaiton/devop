import { cookies } from 'next/headers';
import Link from 'next/link';
import { getSession } from '../../../session';
import { RepoTabs } from './RepoTabs';

interface RepositoryDetail {
  id: string;
  full_name: string;
  default_branch: string;
  webhook_status: string;
}

async function fetchRepository(id: string): Promise<RepositoryDetail | null> {
  const cookieHeader = cookies().toString();
  const res = await fetch(`${process.env.API_INTERNAL_URL}/api/dashboard/repositories/${id}`, {
    headers: { Cookie: cookieHeader },
    cache: 'no-store',
  });
  if (!res.ok) return null;
  return res.json();
}

export default async function RepositoryLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) {
    return <p>No autorizado.</p>;
  }

  const { id } = await params;
  const repository = await fetchRepository(id);
  if (!repository) {
    return (
      <>
        <p>
          <Link href="/">&larr; Repositorios</Link>
        </p>
        <p>No tienes acceso a este repositorio.</p>
      </>
    );
  }

  return (
    <>
      <h1 style={{ marginTop: 0 }}>{repository.full_name}</h1>
      <p style={{ color: 'var(--ink-muted)', marginTop: '-0.5rem' }}>
        Rama por defecto: <code>{repository.default_branch}</code> — Webhook: {repository.webhook_status}
      </p>
      <RepoTabs repositoryId={id} isAdmin={session.role === 'admin'} />
      <div className="repo-tab-panel">{children}</div>
    </>
  );
}
