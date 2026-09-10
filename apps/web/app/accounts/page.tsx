import { cookies } from 'next/headers';
import Link from 'next/link';
import { getSession } from '../session';

interface AccountRow {
  id: string;
  installation_id: string;
  account_login: string;
  status: string;
  repository_count: string;
  created_at: string;
}

async function fetchAccounts(): Promise<AccountRow[]> {
  const cookieHeader = cookies().toString();
  const res = await fetch(`${process.env.API_INTERNAL_URL}/api/dashboard/accounts`, {
    headers: { Cookie: cookieHeader },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`failed to load accounts: ${res.status}`);
  return res.json();
}

export default async function AccountsPage() {
  const session = await getSession();
  if (!session || session.role !== 'admin') {
    return (
      <main>
        <p>No autorizado.</p>
      </main>
    );
  }

  const accounts = await fetchAccounts();

  return (
    <main>
      <p>
        <Link href="/">&larr; Inicio</Link>
      </p>
      <h1>Cuentas de GitHub conectadas</h1>
      <p>
        Cada cuenta/organización de GitHub instalada aquí queda bajo el mismo equipo — sus repos
        se analizan igual que los de la cuenta principal.
      </p>
      {accounts.length === 0 ? (
        <p>Todavía no hay ninguna cuenta conectada.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Cuenta</th>
              <th>Repos</th>
              <th>Estado</th>
              <th>Conectada</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td>{a.account_login}</td>
                <td>{a.repository_count}</td>
                <td>{a.status}</td>
                <td>{new Date(a.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p>
        <a href="/api/auth/github/link-account">Conectar otra cuenta de GitHub</a>
      </p>
    </main>
  );
}
