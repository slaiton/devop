import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSession } from './session';

interface Repository {
  id: string;
  full_name: string;
  default_branch: string;
  webhook_status: string;
}

async function fetchRepositories(): Promise<Repository[]> {
  const cookieHeader = cookies().toString();
  const res = await fetch(`${process.env.API_INTERNAL_URL}/api/dashboard/repositories`, {
    headers: { Cookie: cookieHeader },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`failed to load repositories: ${res.status}`);
  return res.json();
}

async function fetchSetupStatus(): Promise<{ configured: boolean }> {
  const res = await fetch(`${process.env.API_INTERNAL_URL}/api/system-settings/status`, { cache: 'no-store' });
  if (!res.ok) return { configured: true }; // ante la duda, no invitar a re-configurar
  return res.json();
}

export default async function HomePage() {
  const session = await getSession();

  if (!session) {
    const { configured } = await fetchSetupStatus();
    if (!configured) {
      return (
        <main>
          <h1>DevSentinel AI</h1>
          <p>Todavía no se ha configurado la GitHub App de este despliegue.</p>
          <a href="/setup">Configurar DevSentinel AI</a>
        </main>
      );
    }
    return (
      <main>
        <h1>DevSentinel AI</h1>
        <p>Conecta tu cuenta de GitHub para ver tus repositorios.</p>
        <a href="/api/auth/github/login">Iniciar sesión con GitHub</a>
      </main>
    );
  }

  if (session.role !== 'admin') {
    redirect('/me');
  }

  const repositories = await fetchRepositories();

  return (
    <main>
      <p>
        <a href="/overview">Ver pendientes</a> · <a href="/developers">Developers</a> ·{' '}
        <a href="/team">Equipo</a> · <a href="/accounts">Cuentas de GitHub</a> ·{' '}
        <a href="/settings">Configuración del sistema</a> · <a href="/me">Mi perfil</a>
      </p>
      <h1>Repositorios</h1>
      {repositories.length === 0 ? (
        <p>Todavía no hay repositorios conectados. Instala la GitHub App en tu organización para empezar.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Repositorio</th>
              <th>Rama por defecto</th>
              <th>Webhook</th>
            </tr>
          </thead>
          <tbody>
            {repositories.map((repo) => (
              <tr key={repo.id}>
                <td>
                  <a href={`/repositories/${repo.id}`}>{repo.full_name}</a>
                </td>
                <td>{repo.default_branch}</td>
                <td>{repo.webhook_status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
