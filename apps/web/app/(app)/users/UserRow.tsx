'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface RepoRef {
  id: string;
  full_name: string;
}

interface DeveloperRef {
  id: string;
  github_login: string | null;
  email: string | null;
  display_name?: string | null;
}

export interface UserRowData {
  user_id: string;
  name: string | null;
  email: string | null;
  role: string;
  claimed: boolean;
  repositories: RepoRef[];
  developers: DeveloperRef[];
}

async function call(path: string, method: string, body?: unknown): Promise<any> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? `error ${res.status}`);
  return data;
}

export function UserRow({
  user,
  allRepositories,
  unlinkedDevelopers,
}: {
  user: UserRowData;
  allRepositories: RepoRef[];
  unlinkedDevelopers: DeveloperRef[];
}) {
  const router = useRouter();
  const [role, setRole] = useState(user.role);
  const [expanded, setExpanded] = useState(false);
  const [selectedRepos, setSelectedRepos] = useState<Set<string>>(new Set(user.repositories.map((r) => r.id)));
  const [linkDeveloperId, setLinkDeveloperId] = useState(unlinkedDevelopers[0]?.id ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<any>) {
    setLoading(true);
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function toggleRepo(id: string) {
    setSelectedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="card">
      <p>
        <strong>{user.name ?? '(sin nombre)'}</strong> — {user.email ?? '-'}{' '}
        {user.claimed ? (
          <span className="status-ok">activo</span>
        ) : (
          <span className="status-warn">pendiente (no ha iniciado sesión)</span>
        )}
      </p>

      <p>
        <label>
          Rol:{' '}
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="user">Usuario</option>
            <option value="admin">Admin</option>
          </select>
        </label>{' '}
        {role !== user.role && (
          <button disabled={loading} onClick={() => run(() => call(`/api/users/${user.user_id}`, 'PATCH', { role }))}>
            Guardar rol
          </button>
        )}{' '}
        <button
          disabled={loading}
          onClick={() => {
            if (window.confirm('¿Quitar a este usuario de la organización?')) {
              run(() => call(`/api/users/${user.user_id}`, 'DELETE'));
            }
          }}
        >
          Quitar
        </button>
      </p>

      <p>
        <button type="button" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Ocultar accesos' : 'Gestionar repos y developer'}
        </button>
      </p>

      {expanded && (
        <div>
          <p>
            <strong>Repos asignados</strong>{' '}
            {role === 'admin' && <em>(irrelevante: admin ve todos los repos)</em>}
          </p>
          <div className="card-row">
            {allRepositories.map((repo) => (
              <label key={repo.id} style={{ flexDirection: 'row', alignItems: 'center', gap: '0.3em' }}>
                <input
                  type="checkbox"
                  checked={selectedRepos.has(repo.id)}
                  onChange={() => toggleRepo(repo.id)}
                  style={{ minWidth: 0 }}
                />
                {repo.full_name}
              </label>
            ))}
          </div>
          <button
            disabled={loading}
            onClick={() =>
              run(() =>
                call(`/api/users/${user.user_id}/repositories`, 'PUT', { repositoryIds: Array.from(selectedRepos) }),
              )
            }
          >
            Guardar repos
          </button>

          <p>
            <strong>Developer vinculado</strong>
          </p>
          {user.developers.length === 0 ? (
            <p>Sin developer vinculado todavía.</p>
          ) : (
            <ul>
              {user.developers.map((d) => (
                <li key={d.id}>{d.github_login ?? d.email ?? d.id}</li>
              ))}
            </ul>
          )}
          {unlinkedDevelopers.length > 0 && (
            <p>
              <select value={linkDeveloperId} onChange={(e) => setLinkDeveloperId(e.target.value)}>
                {unlinkedDevelopers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.display_name ?? d.github_login ?? d.email ?? d.id}
                  </option>
                ))}
              </select>{' '}
              <button
                disabled={loading || !linkDeveloperId}
                onClick={() => run(() => call(`/api/users/${user.user_id}/developers/${linkDeveloperId}/link`, 'POST'))}
              >
                Vincular
              </button>
            </p>
          )}
        </div>
      )}

      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
