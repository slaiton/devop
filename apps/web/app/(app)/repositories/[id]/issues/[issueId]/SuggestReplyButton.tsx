'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CommentForm } from './CommentForm';

export function SuggestReplyButton({
  issueId,
  status,
  suggestedReply,
  error: initialError,
}: {
  issueId: string;
  status: 'pending' | 'ready' | 'failed' | null;
  suggestedReply: string | null;
  error: string | null;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/issues/${issueId}/suggest-reply`, { method: 'POST' });
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

  if (status === 'ready' && suggestedReply) {
    return (
      <div className="card">
        <p>
          <strong>Borrador sugerido por IA</strong> — revísalo/edítalo antes de publicar:
        </p>
        <CommentForm issueId={issueId} initialBody={suggestedReply} />
        <p>
          <button onClick={handleClick} disabled={loading}>
            {loading ? 'Regenerando…' : 'Regenerar sugerencia'}
          </button>
        </p>
      </div>
    );
  }

  return (
    <div>
      <button onClick={handleClick} disabled={loading || status === 'pending'}>
        {status === 'pending' ? 'Generando sugerencia…' : loading ? 'Solicitando…' : 'Sugerir respuesta con IA'}
      </button>
      {status === 'pending' && <p className="status-warn">Recarga la página en unos segundos para verla.</p>}
      {status === 'failed' && initialError && <p className="error-text">Falló la sugerencia anterior: {initialError}</p>}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
