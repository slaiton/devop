import { cookies } from 'next/headers';
import Link from 'next/link';
import { getSession } from '../../session';
import { DeveloperSoundControls, type SoundOption } from './DeveloperSoundControls';

interface DeveloperRow {
  id: string;
  github_login: string | null;
  email: string | null;
  display_name: string | null;
  user_id: string | null;
  user_email: string | null;
  user_name: string | null;
  notification_sound: string | null;
  notification_volume: number;
  notification_muted: boolean;
  total_reviews: string;
  apto_count: string;
  no_apto_count: string;
  avg_quality_score: number | null;
  blocking_findings_total: string;
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

export default async function DevelopersPage() {
  const session = await getSession();
  if (!session || session.role !== 'admin') {
    return <p>No autorizado.</p>;
  }

  const [developers, catalog] = await Promise.all([
    fetchJson<DeveloperRow[]>('/dashboard/developers'),
    fetchJson<{ default: string; sounds: SoundOption[] }>('/notifications/sounds'),
  ]);

  return (
    <>
      <h1>Developers</h1>
      {developers.length === 0 ? (
        <p>Todavía no hay developers registrados (se crean automáticamente al procesar pushes/PRs).</p>
      ) : (
        <>
          <p style={{ color: 'var(--ink-muted)' }}>
            <strong>Aviso sonoro:</strong> cuando termina el análisis de un commit suena el tono de su autor. Tú oyes el de todos los
            developers; cada developer oye el suyo en su sesión, siempre que su cuenta esté vinculada (se hace desde{' '}
            <Link href="/users">Usuarios</Link>).
          </p>
          <div className="hook-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Developer</th>
                  <th>Cuenta vinculada</th>
                  <th>Aviso sonoro</th>
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
                    <td>
                      {d.user_email ? (
                        d.user_email
                      ) : (
                        <span className="status-warn" title="Sin cuenta vinculada, este developer no oirá sus avisos">
                          sin vincular
                        </span>
                      )}
                    </td>
                    <td>
                      <DeveloperSoundControls
                        developerId={d.id}
                        sounds={catalog.sounds}
                        defaultSound={catalog.default}
                        initial={{ sound: d.notification_sound, volume: d.notification_volume, muted: d.notification_muted }}
                      />
                    </td>
                    <td>{d.total_reviews}</td>
                    <td>{d.apto_count}</td>
                    <td>{d.no_apto_count}</td>
                    <td>{d.avg_quality_score ?? '-'}</td>
                    <td>{d.blocking_findings_total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
