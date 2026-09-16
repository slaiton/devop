'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export function CommentForm({ issueId, initialBody }: { issueId: string; initialBody?: string }) {
  const router = useRouter();
  const [body, setBody] = useState(initialBody ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/issues/${issueId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: body.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message ?? `error ${res.status}`);
      }
      setBody('');
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} placeholder="Escribe un comentario…" />
      <div>
        <button type="submit" disabled={loading || !body.trim()}>
          {loading ? 'Publicando…' : 'Publicar comentario'}
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
    </form>
  );
}
