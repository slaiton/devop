'use client';

import { useState, type FormEvent } from 'react';

export function FirstAdminForm() {
  const [githubAccountLogin, setGithubAccountLogin] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminName, setAdminName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/users/bootstrap-first-admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ githubAccountLogin, organizationName, adminEmail, adminName }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? `error ${res.status}`);
      }
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <p className="status-ok">
        Organización y primer admin registrados. Ahora instala la GitHub App en{' '}
        <code>{githubAccountLogin}</code> e inicia sesión con esa cuenta desde la página principal.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      <p style={{ color: 'var(--ink-muted)' }}>
        La cuenta u organización de GitHub debe coincidir EXACTAMENTE con donde vas a instalar la App —
        si no coincide, la instalación creará una organización aparte y el admin registrado aquí no verá
        sus repos.
      </p>
      <p>
        <label>
          Cuenta u organización de GitHub (ej: <code>tu-usuario</code> o <code>tu-organizacion</code>):
          <input value={githubAccountLogin} onChange={(e) => setGithubAccountLogin(e.target.value)} required />
        </label>
      </p>
      <p>
        <label>
          Nombre de la organización (opcional, solo para mostrar):
          <input value={organizationName} onChange={(e) => setOrganizationName(e.target.value)} />
        </label>
      </p>
      <p>
        <label>
          Correo del primer admin (debe coincidir con el correo público de su cuenta de GitHub):
          <input type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} required />
        </label>
      </p>
      <p>
        <label>
          Nombre del primer admin (opcional):
          <input value={adminName} onChange={(e) => setAdminName(e.target.value)} />
        </label>
      </p>
      <button type="submit" disabled={loading}>
        {loading ? 'Registrando…' : 'Registrar organización y primer admin'}
      </button>
      {error && <p className="error-text">{error}</p>}
    </form>
  );
}
