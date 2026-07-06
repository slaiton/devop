import { cookies } from 'next/headers';

interface Repository {
  id: string;
  full_name: string;
  default_branch: string;
  webhook_status: string;
}

async function fetchRepositories(): Promise<Repository[] | null> {
  const cookieHeader = cookies().toString();
  const res = await fetch(`${process.env.API_INTERNAL_URL}/api/dashboard/repositories`, {
    headers: { Cookie: cookieHeader },
    cache: 'no-store',
  });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`failed to load repositories: ${res.status}`);
  return res.json();
}

export default async function HomePage() {
  const repositories = await fetchRepositories();

  if (!repositories) {
    return (
      <main>
        <h1>DevSentinel AI</h1>
        <p>Conecta tu cuenta de GitHub para ver tus repositorios.</p>
        <a href="/api/auth/github/login">Iniciar sesión con GitHub</a>
      </main>
    );
  }

  return (
    <main>
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
