'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export function InviteForm() {
  const router = useRouter();
  const [githubLogin, setGithubLogin] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/dashboard/team/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ githubLogin }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? `error ${res.status}`);
      }
      setGithubLogin('');
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
          Username de GitHub a invitar (rol: usuario):
          <input value={githubLogin} onChange={(e) => setGithubLogin(e.target.value)} placeholder="octocat" required />
        </label>
      </p>
      <button type="submit" disabled={loading}>
        {loading ? 'Invitando…' : 'Invitar'}
      </button>
      {error && <p className="error-text">{error}</p>}
    </form>
  );
}
