'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function MarkReviewedButton({ repositoryId, reviewRunId }: { repositoryId: string; reviewRunId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/dashboard/repositories/${repositoryId}/review-runs/${reviewRunId}/mark-reviewed`,
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
      <button onClick={handleClick} disabled={loading}>
        {loading ? 'Marcando…' : 'Marcar como revisado'}
      </button>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
