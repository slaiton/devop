'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function IssueStateButton({ issueId, state }: { issueId: string; state: 'open' | 'closed' }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);
    try {
      const action = state === 'open' ? 'close' : 'reopen';
      const res = await fetch(`/api/issues/${issueId}/${action}`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message ?? `error ${res.status}`);
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
      <button onClick={handleClick} disabled={loading}>
        {loading ? 'Guardando…' : state === 'open' ? 'Cerrar issue' : 'Reabrir issue'}
      </button>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
