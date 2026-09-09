import { cookies } from 'next/headers';
import Link from 'next/link';
import { getSession } from '../session';
import { GateBadge } from '../GateBadge';

interface MyProfile {
  developer_id: string | null;
  github_login: string | null;
  email: string | null;
  display_name: string | null;
  total_reviews: string | number;
  apto_count: string | number;
  no_apto_count: string | number;
  avg_quality_score: number | null;
}

interface MyReviewRow {
  id: string;
  repository_id: string;
  full_name: string;
  branch: string | null;
  commit_sha: string;
  trigger: 'push' | 'pull_request';
  gate_decision: 'apto' | 'requiere_revision' | 'no_apto' | null;
  risk_level: 'low' | 'medium' | 'high' | null;
  quality_score: number | null;
  notified_at: string | null;
  started_at: string;
  github_pr_number: number | null;
  pull_request_title: string | null;
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

export default async function MyProfilePage() {
  const session = await getSession();
  if (!session) {
    return (
      <main>
        <p>Conecta tu cuenta de GitHub para ver tu perfil.</p>
        <a href="/api/auth/github/login">Iniciar sesión con GitHub</a>
      </main>
    );
  }

  const [profile, reviews] = await Promise.all([
    fetchJson<MyProfile>('/dashboard/me/profile'),
    fetchJson<MyReviewRow[]>('/dashboard/me/reviews'),
  ]);

  return (
    <main>
      {session.role === 'admin' && (
        <p>
          <Link href="/">&larr; Repositorios</Link>
        </p>
      )}

      <h1>Mi perfil</h1>
      <div className="card">
        <p>
          <strong>{session.name ?? profile.display_name ?? profile.github_login ?? 'Sin nombre'}</strong>
        </p>
        <p>{session.email ?? profile.email ?? '-'}</p>
        <p className="card-row">
          <span className="chip">Reviews: {profile.total_reviews}</span>
          <span className="chip">APTO: {profile.apto_count}</span>
          <span className="chip">NO APTO: {profile.no_apto_count}</span>
          <span className="chip">Score promedio: {profile.avg_quality_score ?? '-'}</span>
        </p>
      </div>

      <h1>Mis pulls, commits y retroalimentación</h1>
      {reviews.length === 0 ? (
        <p>Todavía no hay actividad asociada a tu cuenta.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Repositorio</th>
              <th>Tipo</th>
              <th>Detalle</th>
              <th>Resultado</th>
              <th>Score</th>
              <th>Riesgo</th>
              <th>Fecha</th>
            </tr>
          </thead>
          <tbody>
            {reviews.map((r) => (
              <tr key={r.id}>
                <td>{r.full_name}</td>
                <td>{r.trigger === 'pull_request' ? 'PR' : 'Push'}</td>
                <td>
                  <Link href={`/review-runs/${r.id}`}>
                    {r.trigger === 'pull_request'
                      ? `#${r.github_pr_number}: ${r.pull_request_title ?? ''}`
                      : `${r.branch ?? '-'} @ ${r.commit_sha.slice(0, 7)}`}
                  </Link>
                </td>
                <td>
                  <GateBadge decision={r.gate_decision} />
                </td>
                <td>{r.quality_score ?? '-'}</td>
                <td>{r.risk_level ? <span className={`badge badge-${r.risk_level}`}>{r.risk_level}</span> : '-'}</td>
                <td>{new Date(r.started_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
