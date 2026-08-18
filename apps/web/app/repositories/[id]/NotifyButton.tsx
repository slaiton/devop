'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function NotifyButton({
  repositoryId,
  reviewRunId,
  authorEmail,
}: {
  repositoryId: string;
  reviewRunId: string;
  authorEmail: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (!window.confirm(`¿Enviar el resultado de esta revisión por correo a ${authorEmail}?`)) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/dashboard/repositories/${repositoryId}/review-runs/${reviewRunId}/notify`,
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
        {loading ? 'Enviando…' : 'Enviar por correo'}
      </button>
      {error && <p style={{ color: 'crimson', fontSize: '0.85em' }}>{error}</p>}
    </div>
  );
}
