import { cookies } from 'next/headers';
import Link from 'next/link';

interface RepositoryRow {
  id: string;
  full_name: string;
}

interface PendingPushRow {
  id: string;
  repository_id: string;
  full_name: string;
  branch: string | null;
  commit_sha: string;
  gate_decision: 'apto' | 'no_apto' | null;
  risk_level: 'low' | 'medium' | 'high' | null;
  quality_score: number | null;
  started_at: string;
}

interface Overview {
  repositories: RepositoryRow[];
  pendingPushes: PendingPushRow[];
}

async function fetchOverview(): Promise<Overview> {
  const cookieHeader = cookies().toString();
  const res = await fetch(`${process.env.API_INTERNAL_URL}/api/dashboard/overview`, {
    headers: { Cookie: cookieHeader },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`failed to load overview: ${res.status}`);
  return res.json();
}

export default async function OverviewPage() {
  const { repositories, pendingPushes } = await fetchOverview();

  return (
    <main>
      <p>
        <Link href="/">&larr; Inicio</Link>
      </p>
      <h1>Pendientes por revisar</h1>
      {pendingPushes.length === 0 ? (
        <p>No hay pushes pendientes de atención en ningún repo.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Repositorio</th>
              <th>Rama</th>
              <th>Commit</th>
              <th>Estado</th>
              <th>Riesgo</th>
              <th>Score</th>
              <th>Fecha</th>
            </tr>
          </thead>
          <tbody>
            {pendingPushes.map((run) => (
              <tr key={run.id}>
                <td>
                  <Link href={`/repositories/${run.repository_id}`}>{run.full_name}</Link>
                </td>
                <td>{run.branch ?? '-'}</td>
                <td>
                  <Link href={`/review-runs/${run.id}`}>{run.commit_sha.slice(0, 7)}</Link>
                </td>
                <td>
                  {run.gate_decision === 'apto' ? (
                    <span style={{ color: 'green' }}>✓ APTO</span>
                  ) : (
                    <span style={{ color: 'crimson' }}>❌ NO APTO</span>
                  )}
                </td>
                <td>{run.risk_level ? <span className={`badge badge-${run.risk_level}`}>{run.risk_level}</span> : '-'}</td>
                <td>{run.quality_score ?? '-'}</td>
                <td>{new Date(run.started_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h1>Acceso rápido a repos</h1>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
        {repositories.map((repo) => (
          <Link
            key={repo.id}
            href={`/repositories/${repo.id}`}
            style={{ border: '1px solid #ccc', borderRadius: 6, padding: '0.5rem 0.75rem' }}
          >
            {repo.full_name}
          </Link>
        ))}
      </div>
    </main>
  );
}
