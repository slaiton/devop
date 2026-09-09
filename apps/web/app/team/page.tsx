import { cookies } from 'next/headers';
import Link from 'next/link';
import { getSession } from '../session';
import { InviteForm } from './InviteForm';

interface TeamMemberRow {
  role: string;
  user_id: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
  created_at: string;
}

async function fetchTeam(): Promise<TeamMemberRow[]> {
  const cookieHeader = cookies().toString();
  const res = await fetch(`${process.env.API_INTERNAL_URL}/api/dashboard/team`, {
    headers: { Cookie: cookieHeader },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`failed to load team: ${res.status}`);
  return res.json();
}

const ROLE_LABEL: Record<string, string> = { admin: 'Admin', developer: 'Usuario', owner: 'Owner', viewer: 'Viewer' };

export default async function TeamPage() {
  const session = await getSession();
  if (!session || session.role !== 'admin') {
    return (
      <main>
        <p>No autorizado.</p>
      </main>
    );
  }

  const members = await fetchTeam();

  return (
    <main>
      <p>
        <Link href="/">&larr; Repositorios</Link>
      </p>
      <h1>Equipo</h1>
      <table>
        <thead>
          <tr>
            <th>Miembro</th>
            <th>Email</th>
            <th>Rol</th>
            <th>Desde</th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.user_id}>
              <td>{m.name ?? '-'}</td>
              <td>{m.email ?? '-'}</td>
              <td>{ROLE_LABEL[m.role] ?? m.role}</td>
              <td>{new Date(m.created_at).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h1>Invitar usuario</h1>
      <InviteForm />
    </main>
  );
}
