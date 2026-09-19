'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function ReconsiderFindingButton({
  repositoryId,
  reviewRunId,
  findingId,
}: {
  repositoryId: string;
  reviewRunId: string;
  findingId: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (!comment.trim()) {
      setError('el comentario no puede estar vacío');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/dashboard/repositories/${repositoryId}/review-runs/${reviewRunId}/findings/${findingId}/reconsider`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ comment: comment.trim() }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? `error ${res.status}`);
      }
      setOpen(false);
      setComment('');
      setSubmitted(true);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  if (submitted) {
    return <p className="status-warn">⏳ En reconsideración…</p>;
  }

  if (!open) {
    return <button onClick={() => setOpen(true)}>Comentar y reconsiderar</button>;
  }

  return (
    <div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Ej: ya corregido, revisa de nuevo / esto es un falso positivo porque..."
        rows={3}
      />
      <div>
        <button onClick={handleSubmit} disabled={loading}>
          {loading ? 'Enviando…' : 'Enviar a reconsideración'}
        </button>{' '}
        <button
          onClick={() => {
            setOpen(false);
            setComment('');
            setError(null);
          }}
          disabled={loading}
        >
          Cancelar
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
