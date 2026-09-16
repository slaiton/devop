'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface MemberOption {
  userId: string;
  name: string | null;
  email: string | null;
}

function label(m: MemberOption): string {
  return m.name ?? m.email ?? m.userId;
}

export function RepoMembersForm({
  repositoryId,
  members,
  candidates,
}: {
  repositoryId: string;
  members: MemberOption[];
  candidates: MemberOption[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState(candidates[0]?.userId ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addMember() {
    if (!selected) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/repositories/${repositoryId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: selected }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? `error ${res.status}`);
      }
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function removeMember(userId: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/repositories/${repositoryId}/members/${userId}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? `error ${res.status}`);
      }
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      {members.length === 0 ? (
        <p>Nadie tiene este repositorio asignado todavía — solo los admins lo ven.</p>
      ) : (
        <ul>
          {members.map((m) => (
            <li key={m.userId}>
              {label(m)}{' '}
              <button type="button" disabled={loading} onClick={() => removeMember(m.userId)}>
                Quitar
              </button>
            </li>
          ))}
        </ul>
      )}

      {candidates.length > 0 && (
        <p>
          <select value={selected} onChange={(e) => setSelected(e.target.value)}>
            {candidates.map((c) => (
              <option key={c.userId} value={c.userId}>
                {label(c)}
              </option>
            ))}
          </select>{' '}
          <button type="button" disabled={loading || !selected} onClick={addMember}>
            Agregar
          </button>
        </p>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
