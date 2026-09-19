'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export function AddGithubAppForm() {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState('');
  const [githubAppId, setGithubAppId] = useState('');
  const [slug, setSlug] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/github-apps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, githubAppId, slug, clientId, clientSecret, privateKey, webhookSecret }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? `error ${res.status}`);
      }
      setName('');
      setGithubAppId('');
      setSlug('');
      setClientId('');
      setClientSecret('');
      setPrivateKey('');
      setWebhookSecret('');
      setExpanded(false);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  if (!expanded) {
    return (
      <p>
        <button type="button" onClick={() => setExpanded(true)}>
          + Agregar GitHub App
        </button>
      </p>
    );
  }

  return (
    <div className="card">
      <p style={{ color: 'var(--ink-muted)' }}>
        Los datos salen de la página de configuración de tu GitHub App en{' '}
        <a href="https://github.com/settings/apps" target="_blank" rel="noreferrer">
          github.com/settings/apps
        </a>
        . En esa App, configurá el <strong>Setup URL</strong> (con &quot;Redirect on update&quot;
        activado) apuntando a <code>{'{PUBLIC_WEB_ORIGIN}'}/api/github-apps/callback</code> de este
        despliegue — sin eso, conectar una cuenta no va a volver acá.
      </p>
      <form onSubmit={handleSubmit}>
        <p>
          <label>
            Nombre (solo para identificarla acá):
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
        </p>
        <p>
          <label>
            App ID:
            <input value={githubAppId} onChange={(e) => setGithubAppId(e.target.value)} required />
          </label>
        </p>
        <p>
          <label>
            Slug (de github.com/apps/&lt;slug&gt;):
            <input value={slug} onChange={(e) => setSlug(e.target.value)} required />
          </label>
        </p>
        <p>
          <label>
            Client ID:
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} required />
          </label>
        </p>
        <p>
          <label>
            Client secret:
            <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} required />
          </label>
        </p>
        <p>
          <label>
            Private key (PEM completo):
            <textarea
              rows={4}
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              placeholder="-----BEGIN RSA PRIVATE KEY-----"
              required
            />
          </label>
        </p>
        <p>
          <label>
            Webhook secret:
            <input type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} required />
          </label>
        </p>
        <button type="submit" disabled={loading}>
          {loading ? 'Registrando…' : 'Registrar GitHub App'}
        </button>{' '}
        <button type="button" onClick={() => setExpanded(false)} disabled={loading}>
          Cancelar
        </button>
        {error && <p className="error-text">{error}</p>}
      </form>
    </div>
  );
}
