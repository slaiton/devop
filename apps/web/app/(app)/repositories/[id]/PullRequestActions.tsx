'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

async function postJson(path: string, body?: unknown): Promise<any> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? `error ${res.status}`);
  return data;
}

export function CreatePullRequestButton({ repositoryId, reviewRunId }: { repositoryId: string; reviewRunId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (!window.confirm('¿Crear (o reutilizar) el Pull Request de este commit hacia la rama destino configurada?')) return;
    setLoading(true);
    setError(null);
    try {
      await postJson('/pull-requests/from-push', { repositoryId, reviewRunId });
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
        {loading ? 'Creando…' : 'Crear Pull Request'}
      </button>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

export function MergePullRequestButton({ pullRequestId }: { pullRequestId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);
    try {
      const { canMerge, reasons } = await postJson(`/pull-requests/${pullRequestId}/validate-merge`);
      if (!canMerge) {
        setError(`No se puede mergear: ${reasons.join('; ')}`);
        return;
      }
      if (!window.confirm('¿Confirmas mergear este Pull Request?')) return;
      await postJson(`/pull-requests/${pullRequestId}/merge`);
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
        {loading ? 'Validando…' : 'Mergear'}
      </button>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
