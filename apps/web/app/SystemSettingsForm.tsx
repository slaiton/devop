'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export interface SystemSettingsInitial {
  smtpHost: string | null;
  smtpPort: number | null;
  smtpUser: string | null;
  smtpFrom: string | null;
  smtpPasswordSet: boolean;
}

export function SystemSettingsForm({
  endpoint,
  method,
  initial,
  redirectOnSuccess,
}: {
  endpoint: string;
  method: 'POST' | 'PATCH';
  initial: SystemSettingsInitial;
  redirectOnSuccess?: string;
}) {
  const router = useRouter();
  const [smtpHost, setSmtpHost] = useState(initial.smtpHost ?? '');
  const [smtpPort, setSmtpPort] = useState(initial.smtpPort?.toString() ?? '587');
  const [smtpUser, setSmtpUser] = useState(initial.smtpUser ?? '');
  const [smtpFrom, setSmtpFrom] = useState(initial.smtpFrom ?? '');
  const [smtpPassword, setSmtpPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          smtpHost,
          smtpPort: smtpPort ? Number(smtpPort) : undefined,
          smtpUser,
          smtpFrom,
          smtpPassword: smtpPassword || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? `error ${res.status}`);
      }
      setSaved(true);
      setSmtpPassword('');
      if (redirectOnSuccess) {
        router.push(redirectOnSuccess);
      } else {
        router.refresh();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <h2>SMTP (opcional, para notificar por correo)</h2>
      <p>
        <label>Host: <input value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} /></label>
      </p>
      <p>
        <label>Puerto: <input value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} /></label>
      </p>
      <p>
        <label>Usuario: <input value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} /></label>
      </p>
      <p>
        <label>
          Contraseña {initial.smtpPasswordSet && <span className="status-ok">(configurada)</span>}:
          <input
            type="password"
            value={smtpPassword}
            onChange={(e) => setSmtpPassword(e.target.value)}
            placeholder={initial.smtpPasswordSet ? '•••••••• (dejar vacío para no cambiar)' : ''}
          />
        </label>
      </p>
      <p>
        <label>Remitente: <input value={smtpFrom} onChange={(e) => setSmtpFrom(e.target.value)} placeholder="DevSentinel AI <no-reply@tu-dominio.com>" /></label>
      </p>

      <button type="submit" disabled={loading}>
        {loading ? 'Guardando…' : 'Guardar'}
      </button>
      {saved && <span className="status-ok" style={{ marginLeft: '0.5em' }}>Guardado</span>}
      {error && <p className="error-text">{error}</p>}
    </form>
  );
}
