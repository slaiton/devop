'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export function RepoSettingsForm({
  repositoryId,
  promotionSourceBranch,
  promotionTargetBranch,
  autoCreatePrOnPush,
  notifyAuthorOnPush,
  autoMergeOnGreen,
}: {
  repositoryId: string;
  promotionSourceBranch: string;
  promotionTargetBranch: string;
  autoCreatePrOnPush: boolean;
  notifyAuthorOnPush: boolean;
  autoMergeOnGreen: boolean;
}) {
  const router = useRouter();
  const [sourceBranch, setSourceBranch] = useState(promotionSourceBranch);
  const [targetBranch, setTargetBranch] = useState(promotionTargetBranch);
  const [autoCreatePr, setAutoCreatePr] = useState(autoCreatePrOnPush);
  const [notifyAuthor, setNotifyAuthor] = useState(notifyAuthorOnPush);
  const [autoMerge, setAutoMerge] = useState(autoMergeOnGreen);
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
          promotionSourceBranch: sourceBranch.trim(),
          promotionTargetBranch: targetBranch.trim(),
          autoCreatePrOnPush: autoCreatePr,
          notifyAuthorOnPush: notifyAuthor,
          autoMergeOnGreen: autoMerge,
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
      <p style={{ color: 'var(--ink-muted)' }}>
        Se analiza cualquier push a cualquier rama del repositorio, excepto la rama principal (default).
      </p>
      <p>
        <label>
          Rama origen para Pull Request: <input value={sourceBranch} onChange={(e) => setSourceBranch(e.target.value)} />
        </label>
      </p>
      <p>
        <label>
          Rama destino para Pull Request: <input value={targetBranch} onChange={(e) => setTargetBranch(e.target.value)} />
        </label>
      </p>
      <p>
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: '0.4rem' }}>
          <input type="checkbox" checked={autoCreatePr} onChange={(e) => setAutoCreatePr(e.target.checked)} style={{ minWidth: 0 }} />
          Crear Pull Request automáticamente cuando un push a la rama origen salga APTO
        </label>
      </p>
      <p>
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: '0.4rem' }}>
          <input type="checkbox" checked={notifyAuthor} onChange={(e) => setNotifyAuthor(e.target.checked)} style={{ minWidth: 0 }} />
          Notificar por correo al autor de cada push analizado
        </label>
      </p>
      <p>
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: '0.4rem' }}>
          <input type="checkbox" checked={autoMerge} onChange={(e) => setAutoMerge(e.target.checked)} style={{ minWidth: 0 }} />
          Mergear automáticamente el Pull Request de promoción cuando un push a la rama origen salga APTO (score verde) — sin revisión
          humana
        </label>
      </p>
      <button type="submit" disabled={loading}>
        {loading ? 'Guardando…' : 'Guardar'}
      </button>
      {saved && <span className="status-ok" style={{ marginLeft: '0.5em' }}>Guardado</span>}
      {error && <p className="error-text">{error}</p>}
    </form>
  );
}
