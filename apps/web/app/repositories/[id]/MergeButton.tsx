'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function MergeButton({
  repositoryId,
  pullRequestId,
  prNumber,
  riskLevel,
}: {
  repositoryId: string;
  pullRequestId: string;
  prNumber: number;
  riskLevel: 'low' | 'medium' | 'high' | null;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleMerge() {
    const warning = riskLevel === 'high' ? '\n\nAdvertencia: la auditoría marcó este PR con riesgo ALTO.' : '';
    if (!window.confirm(`¿Confirmas hacer merge del PR #${prNumber}?${warning}`)) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/dashboard/repositories/${repositoryId}/pull-requests/${pullRequestId}/merge`,
        { method: 'POST' },
      );
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
      <button onClick={handleMerge} disabled={loading}>
        {loading ? 'Mergeando…' : 'Merge'}
      </button>
      {error && <p style={{ color: 'crimson', fontSize: '0.85em' }}>{error}</p>}
    </div>
  );
}
