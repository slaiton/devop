'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function SyncIssuesButton({ repositoryId }: { repositoryId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [synced, setSynced] = useState<number | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);
    setSynced(null);
    try {
      const res = await fetch(`/api/issues/repository/${repositoryId}/backfill`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message ?? `error ${res.status}`);
      setSynced(data.synced ?? 0);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button onClick={handleClick} disabled={loading}>
        {loading ? 'Sincronizando…' : 'Sincronizar issues ahora'}
      </button>
      {synced !== null && <span className="status-ok" style={{ marginLeft: '0.5em' }}>{synced} issues sincronizados</span>}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
