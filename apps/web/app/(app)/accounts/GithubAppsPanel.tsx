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
  repos_synced_at: string | null;
}

const LINK_ERROR_MESSAGES: Record<string, string> = {
  missing_params: 'GitHub no devolvió los datos esperados — intentá conectar de nuevo.',
  invalid_state: 'El enlace de conexión expiró o no es válido — intentá conectar de nuevo desde acá.',
  link_failed: 'No se pudo completar la conexión (revisá que las credenciales de la App sean correctas).',
};

function timeAgo(iso: string | null): string {
  if (!iso) return 'nunca';
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'hace instantes';
  if (min < 60) return `hace ${min} min`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `hace ${hrs} h`;
  const days = Math.floor(hrs / 24);
  return `hace ${days} d`;
}

export function GithubAppsPanel({
  apps,
  connected,
  linkError,
  syncError,
}: {
  apps: GithubAppRow[];
  connected: boolean;
  linkError: string | null;
  syncError: boolean;
}) {
  const router = useRouter();
  const [activeId, setActiveId] = useState<string | null>(apps[0]?.id ?? null);
  const [installations, setInstallations] = useState<Record<string, InstallationRow[]>>({});
  const [loadingInstallations, setLoadingInstallations] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!apps.find((a) => a.id === activeId)) {
      setActiveId(apps[0]?.id ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apps]);

  function loadInstallations(appId: string) {
    setLoadingInstallations(true);
    return fetch(`/api/github-apps/${appId}/installations`)
      .then((res) => {
        if (!res.ok) throw new Error(`error ${res.status}`);
        return res.json();
      })
      .then((rows) => setInstallations((prev) => ({ ...prev, [appId]: rows })))
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoadingInstallations(false));
  }

  useEffect(() => {
    if (!activeId || installations[activeId]) return;
    loadInstallations(activeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

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

  async function handleSync(installationRowId: string) {
    if (!activeId) return;
    setSyncingId(installationRowId);
    setError(null);
    try {
      const res = await fetch(`/api/github-apps/installations/${installationRowId}/sync`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? `error ${res.status}`);
      }
      await loadInstallations(activeId);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSyncingId(null);
    }
  }

  const activeApp = apps.find((a) => a.id === activeId) ?? null;
  const activeInstallations = activeId ? installations[activeId] : undefined;

  return (
    <>
      {connected && !syncError && <p className="status-ok">Cuenta de GitHub conectada y repos sincronizados correctamente.</p>}
      {connected && syncError && (
        <p className="status-warn">
          Cuenta conectada, pero no se pudo sincronizar sus repos automáticamente — usá &quot;Sincronizar ahora&quot; abajo.
        </p>
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
                      <th>Conexión</th>
                      <th>Conectada</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {activeInstallations.map((inst) => (
                      <tr key={inst.id}>
                        <td>{inst.account_login}</td>
                        <td>{inst.repository_count}</td>
                        <td>{inst.status === 'active' ? <span className="status-ok">activa</span> : <span className="status-bad">{inst.status}</span>}</td>
                        <td>
                          {inst.repos_synced_at ? (
                            <span className="status-ok">sincronizado {timeAgo(inst.repos_synced_at)}</span>
                          ) : (
                            <span className="status-warn">nunca sincronizado</span>
                          )}
                        </td>
                        <td>{new Date(inst.created_at).toLocaleDateString()}</td>
                        <td>
                          <button type="button" onClick={() => handleSync(inst.id)} disabled={syncingId === inst.id}>
                            {syncingId === inst.id ? 'Sincronizando…' : 'Sincronizar ahora'}
                          </button>
                        </td>
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
