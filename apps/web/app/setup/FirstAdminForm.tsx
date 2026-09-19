'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export function FirstAdminForm() {
  const router = useRouter();
  const [organizationSlug, setOrganizationSlug] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminName, setAdminName] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/users/bootstrap-first-admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationSlug, organizationName, adminEmail, adminName, adminPassword }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? `error ${res.status}`);
      }
      router.push('/');
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
          Identificador de la organización (slug, ej: <code>mi-empresa</code>):
          <input value={organizationSlug} onChange={(e) => setOrganizationSlug(e.target.value)} required />
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
          Correo del primer admin:
          <input type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} required />
        </label>
      </p>
      <p>
        <label>
          Nombre del primer admin (opcional):
          <input value={adminName} onChange={(e) => setAdminName(e.target.value)} />
        </label>
      </p>
      <p>
        <label>
          Contraseña (mínimo 8 caracteres):
          <input
            type="password"
            value={adminPassword}
            onChange={(e) => setAdminPassword(e.target.value)}
            minLength={8}
            required
          />
        </label>
      </p>
      <button type="submit" disabled={loading}>
        {loading ? 'Registrando…' : 'Registrar organización y primer admin'}
      </button>
      {error && <p className="error-text">{error}</p>}
    </form>
  );
}
