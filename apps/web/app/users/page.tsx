import { cookies } from 'next/headers';
import Link from 'next/link';
import { getSession } from '../session';
import { CreateUserForm } from './CreateUserForm';
import { UserRow, type UserRowData } from './UserRow';

interface RepoRef {
  id: string;
  full_name: string;
}

interface DeveloperRef {
  id: string;
  github_login: string | null;
  email: string | null;
  display_name: string | null;
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

export default async function UsersPage() {
  const session = await getSession();
  if (!session || session.role !== 'admin') {
    return (
      <main>
        <p>No autorizado.</p>
      </main>
    );
  }

  const [users, repositories, unlinkedDevelopers] = await Promise.all([
    fetchJson<UserRowData[]>('/users'),
    fetchJson<RepoRef[]>('/dashboard/repositories'),
    fetchJson<DeveloperRef[]>('/users/developers/unlinked'),
  ]);

  return (
    <main>
      <p>
        <Link href="/">&larr; Repositorios</Link>
      </p>
      <h1>Usuarios</h1>
      <p style={{ color: 'var(--text-muted)' }}>
        El login con GitHub solo funciona para correos ya registrados aquí. Un usuario "pendiente" puede
        iniciar sesión apenas su cuenta de GitHub tenga ese mismo correo como público.
      </p>

      {users.length === 0 ? (
        <p>Todavía no hay usuarios registrados.</p>
      ) : (
        users.map((u) => (
          <UserRow key={u.user_id} user={u} allRepositories={repositories} unlinkedDevelopers={unlinkedDevelopers} />
        ))
      )}

      <h1>Registrar usuario</h1>
      <CreateUserForm />
    </main>
  );
}
