import { cookies } from 'next/headers';
import Link from 'next/link';
import { getSession } from '../session';
import { SystemSettingsForm, type SystemSettingsInitial } from '../SystemSettingsForm';

async function fetchSettings(): Promise<SystemSettingsInitial> {
  const cookieHeader = cookies().toString();
  const res = await fetch(`${process.env.API_INTERNAL_URL}/api/system-settings`, {
    headers: { Cookie: cookieHeader },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`failed to load settings: ${res.status}`);
  return res.json();
}

export default async function SettingsPage() {
  const session = await getSession();
  if (!session || session.role !== 'admin') {
    return (
      <main>
        <p>No autorizado.</p>
      </main>
    );
  }

  const settings = await fetchSettings();

  return (
    <main>
      <p>
        <Link href="/">&larr; Inicio</Link>
      </p>
      <h1>Configuración del sistema</h1>
      <p>GitHub App, proveedor LLM y SMTP — antes vivían en el <code>.env</code> del servidor.</p>
      <SystemSettingsForm endpoint="/api/system-settings" method="PATCH" initial={settings} />
    </main>
  );
}
