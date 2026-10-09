import { cookies } from 'next/headers';
import { getSession } from '../../session';
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
    return <p>No autorizado.</p>;
  }

  const [users, repositories, unlinkedDevelopers] = await Promise.all([
    fetchJson<UserRowData[]>('/users'),
    fetchJson<RepoRef[]>('/dashboard/repositories'),
    fetchJson<DeveloperRef[]>('/users/developers/unlinked'),
  ]);

  return (
    <>
      <h1>Usuarios</h1>
      <p style={{ color: 'var(--ink-muted)' }}>
        Las personas entran con passkey (huella, rostro o PIN del dispositivo) o con su contraseña, y solo si su
        correo está registrado aquí. La contraseña que fijas al crear o restablecer a alguien es temporal: la
        persona debe cambiarla en su primer ingreso, y desde "Mi perfil" puede registrar su passkey.
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
    </>
  );
}
