'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

async function postJson(path: string, body?: unknown): Promise<void> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const responseBody = await res.json().catch(() => ({}));
    throw new Error(responseBody.message ?? `error ${res.status}`);
  }
}

export function RequestPromotionButton({
  repositoryId,
  reviewRunId,
  targetBranch,
}: {
  repositoryId: string;
  reviewRunId: string;
  targetBranch: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (!window.confirm(`¿Solicitar promoción de este commit hacia ${targetBranch}?`)) return;
    setLoading(true);
    setError(null);
    try {
      await postJson(`/dashboard/repositories/${repositoryId}/promotions`, { reviewRunId });
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
        {loading ? 'Solicitando…' : 'Solicitar promoción'}
      </button>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

export function PromotionDecisionButtons({
  promotionId,
  sourceBranch,
  targetBranch,
}: {
  promotionId: string;
  sourceBranch: string;
  targetBranch: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleApprove() {
    if (!window.confirm(`¿Aprobar y mergear ${sourceBranch} → ${targetBranch}?`)) return;
    setLoading('approve');
    setError(null);
    try {
      await postJson(`/promotions/${promotionId}/approve`);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(null);
    }
  }

  async function handleReject() {
    if (!window.confirm('¿Rechazar esta promoción?')) return;
    setLoading('reject');
    setError(null);
    try {
      await postJson(`/promotions/${promotionId}/reject`);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(null);
    }
  }

  return (
    <div>
      <button onClick={handleApprove} disabled={loading !== null}>
        {loading === 'approve' ? 'Aprobando…' : 'Aprobar'}
      </button>{' '}
      <button onClick={handleReject} disabled={loading !== null}>
        {loading === 'reject' ? 'Rechazando…' : 'Rechazar'}
      </button>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
