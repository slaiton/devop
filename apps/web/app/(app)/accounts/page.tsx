import { cookies } from 'next/headers';
import { getSession } from '../../session';
import { GithubAppsPanel, type GithubAppRow } from './GithubAppsPanel';

async function fetchGithubApps(): Promise<GithubAppRow[]> {
  const cookieHeader = cookies().toString();
  const res = await fetch(`${process.env.API_INTERNAL_URL}/api/github-apps`, {
    headers: { Cookie: cookieHeader },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`failed to load github apps: ${res.status}`);
  return res.json();
}

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; link_error?: string; sync_error?: string }>;
}) {
  const session = await getSession();
  if (!session || session.role !== 'admin') {
    return <p>No autorizado.</p>;
  }

  const [apps, params] = await Promise.all([fetchGithubApps(), searchParams]);

  return (
    <>
      <h1>GitHub Apps conectadas</h1>
      <p style={{ color: 'var(--ink-muted)' }}>
        Cada GitHub App registrada acá puede instalarse en una o varias cuentas/organizaciones de
        GitHub — todas las que instales quedan bajo este mismo equipo, con sus repos analizados igual
        que los de la cuenta principal. Una organización puede tener varias Apps conectadas al mismo
        tiempo (ej. una personal y una del trabajo). El estado de &quot;Conexión&quot; de cada cuenta
        instalada muestra si sus repos ya se sincronizaron.
      </p>

      <GithubAppsPanel
        apps={apps}
        connected={params.connected === '1'}
        linkError={params.link_error ?? null}
        syncError={params.sync_error === '1'}
      />
    </>
  );
}
