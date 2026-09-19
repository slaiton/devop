'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AddGithubAppForm } from './AddGithubAppForm';

export interface GithubAppRow {
  id: string;
  name: string;
  github_app_id: string;
  slug: string;
  client_id: string;
  installation_count: number;
  created_at: string;
}

interface InstallationRow {
  id: string;
  installation_id: string;
  account_login: string;
  status: string;
  repository_count: number;
  created_at: string;
}

const LINK_ERROR_MESSAGES: Record<string, string> = {
  missing_params: 'GitHub no devolvió los datos esperados — intentá conectar de nuevo.',
  invalid_state: 'El enlace de conexión expiró o no es válido — intentá conectar de nuevo desde acá.',
  link_failed: 'No se pudo completar la conexión (revisá que las credenciales de la App sean correctas).',
};

export function GithubAppsPanel({
  apps,
  connected,
  linkError,
}: {
  apps: GithubAppRow[];
  connected: boolean;
  linkError: string | null;
}) {
  const router = useRouter();
  const [activeId, setActiveId] = useState<string | null>(apps[0]?.id ?? null);
  const [installations, setInstallations] = useState<Record<string, InstallationRow[]>>({});
  const [loadingInstallations, setLoadingInstallations] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!apps.find((a) => a.id === activeId)) {
      setActiveId(apps[0]?.id ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apps]);

  useEffect(() => {
    if (!activeId || installations[activeId]) return;
    setLoadingInstallations(true);
    fetch(`/api/github-apps/${activeId}/installations`)
      .then((res) => {
        if (!res.ok) throw new Error(`error ${res.status}`);
        return res.json();
      })
      .then((rows) => setInstallations((prev) => ({ ...prev, [activeId]: rows })))
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoadingInstallations(false));
  }, [activeId, installations]);

  async function handleRemove(app: GithubAppRow) {
    if (!window.confirm(`¿Eliminar la GitHub App "${app.name}"? Sus instalaciones y repos quedarán sin App asociada.`)) {
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/github-apps/${app.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? `error ${res.status}`);
      }
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  const activeApp = apps.find((a) => a.id === activeId) ?? null;
  const activeInstallations = activeId ? installations[activeId] : undefined;

  return (
    <>
      {connected && (
        <p className="status-ok">Cuenta de GitHub conectada correctamente.</p>
      )}
      {linkError && (
        <p className="error-text">{LINK_ERROR_MESSAGES[linkError] ?? 'No se pudo completar la conexión.'}</p>
      )}

      {apps.length === 0 ? (
        <p>Todavía no hay ninguna GitHub App registrada.</p>
      ) : (
        <>
          <nav className="repo-tabs">
            {apps.map((app) => (
              <button
                key={app.id}
                type="button"
                className={`repo-tab${app.id === activeId ? ' repo-tab-active' : ''}`}
                onClick={() => setActiveId(app.id)}
              >
                {app.name} {app.installation_count > 0 && `(${app.installation_count})`}
              </button>
            ))}
          </nav>

          {activeApp && (
            <div className="repo-tab-panel">
              <div className="card">
                <p className="card-row">
                  <span className="chip">App ID: {activeApp.github_app_id}</span>
                  <span className="chip">Slug: {activeApp.slug}</span>
                  <span className="chip">Client ID: {activeApp.client_id}</span>
                </p>
                <p>
                  <button
                    type="button"
                    onClick={() => {
                      window.location.href = `/api/github-apps/${activeApp.id}/connect`;
                    }}
                  >
                    Conectar una cuenta/organización
                  </button>{' '}
                  <button type="button" onClick={() => handleRemove(activeApp)} disabled={deleting}>
                    Eliminar App
                  </button>
                </p>
              </div>

              <h2>Cuentas instaladas</h2>
              {loadingInstallations && !activeInstallations ? (
                <p>Cargando…</p>
              ) : !activeInstallations || activeInstallations.length === 0 ? (
                <p>Todavía no se instaló esta App en ninguna cuenta.</p>
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
                    {activeInstallations.map((inst) => (
                      <tr key={inst.id}>
                        <td>{inst.account_login}</td>
                        <td>{inst.repository_count}</td>
                        <td>{inst.status}</td>
                        <td>{new Date(inst.created_at).toLocaleDateString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </>
      )}

      {error && <p className="error-text">{error}</p>}

      <h2 style={{ marginTop: '1.5rem' }}>Registrar otra GitHub App</h2>
      <AddGithubAppForm />
    </>
  );
}
