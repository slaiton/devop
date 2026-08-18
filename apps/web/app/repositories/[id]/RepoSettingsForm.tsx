'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export function RepoSettingsForm({
  repositoryId,
  monitoredBranches,
  promotionSourceBranch,
  promotionTargetBranch,
}: {
  repositoryId: string;
  monitoredBranches: string[];
  promotionSourceBranch: string;
  promotionTargetBranch: string;
}) {
  const router = useRouter();
  const [branches, setBranches] = useState(monitoredBranches.join(', '));
  const [sourceBranch, setSourceBranch] = useState(promotionSourceBranch);
  const [targetBranch, setTargetBranch] = useState(promotionTargetBranch);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/dashboard/repositories/${repositoryId}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          monitoredBranches: branches
            .split(',')
            .map((b) => b.trim())
            .filter(Boolean),
          promotionSourceBranch: sourceBranch.trim(),
          promotionTargetBranch: targetBranch.trim(),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? `error ${res.status}`);
      }
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <p>
        <label>
          Ramas monitoreadas (separadas por coma, vacío = todas):{' '}
          <input value={branches} onChange={(e) => setBranches(e.target.value)} placeholder="staging, feature/*" />
        </label>
      </p>
      <p>
        <label>
          Rama origen de promoción: <input value={sourceBranch} onChange={(e) => setSourceBranch(e.target.value)} />
        </label>
      </p>
      <p>
        <label>
          Rama destino de promoción: <input value={targetBranch} onChange={(e) => setTargetBranch(e.target.value)} />
        </label>
      </p>
      <button type="submit" disabled={loading}>
        {loading ? 'Guardando…' : 'Guardar'}
      </button>
      {saved && <span style={{ color: 'green', marginLeft: '0.5em' }}>Guardado</span>}
      {error && <p style={{ color: 'crimson', fontSize: '0.85em' }}>{error}</p>}
    </form>
  );
}
