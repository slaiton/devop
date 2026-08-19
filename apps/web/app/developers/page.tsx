import { cookies } from 'next/headers';
import Link from 'next/link';

interface DeveloperRow {
  id: string;
  github_login: string | null;
  email: string | null;
  display_name: string | null;
  total_reviews: string;
  apto_count: string;
  no_apto_count: string;
  avg_quality_score: number | null;
  blocking_findings_total: string;
}

async function fetchDevelopers(): Promise<DeveloperRow[]> {
  const cookieHeader = cookies().toString();
  const res = await fetch(`${process.env.API_INTERNAL_URL}/api/dashboard/developers`, {
    headers: { Cookie: cookieHeader },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`failed to load developers: ${res.status}`);
  return res.json();
}

export default async function DevelopersPage() {
  const developers = await fetchDevelopers();

  return (
    <main>
      <p>
        <Link href="/">&larr; Inicio</Link>
      </p>
      <h1>Developers</h1>
      {developers.length === 0 ? (
        <p>Todavía no hay developers registrados (se crean automáticamente al procesar pushes/PRs).</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Developer</th>
              <th>Reviews</th>
              <th>APTO</th>
              <th>NO APTO</th>
              <th>Score promedio</th>
              <th>Hallazgos bloqueantes</th>
            </tr>
          </thead>
          <tbody>
            {developers.map((d) => (
              <tr key={d.id}>
                <td>{d.display_name ?? d.github_login ?? d.email}</td>
                <td>{d.total_reviews}</td>
                <td>{d.apto_count}</td>
                <td>{d.no_apto_count}</td>
                <td>{d.avg_quality_score ?? '-'}</td>
                <td>{d.blocking_findings_total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
