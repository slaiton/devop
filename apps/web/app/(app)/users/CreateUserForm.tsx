'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export function CreateUserForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<'admin' | 'user'>('user');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), name: name.trim() || undefined, role, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? `error ${res.status}`);
      }
      const created = await res.json().catch(() => ({}));
      setNotice(
        created.verification_email_sent
          ? 'Usuario creado. Le enviamos un correo para verificar su dirección; la contraseña que fijaste es temporal.'
          : 'Usuario creado, pero no se pudo enviar el correo de verificación (¿SMTP sin configurar?). Puedes reenviarlo desde su tarjeta cuando esté listo. La contraseña que fijaste es temporal.',
      );
      setEmail('');
      setName('');
      setRole('user');
      setPassword('');
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
          Correo: <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
      </p>
      <p>
        <label>
          Nombre (opcional): <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      </p>
      <p>
        <label>
          Rol:{' '}
          <select value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'user')}>
            <option value="user">Usuario</option>
            <option value="admin">Admin</option>
          </select>
        </label>
      </p>
      <p>
        <label>
          Contraseña (mínimo 8 caracteres):
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>
      </p>
      <button type="submit" disabled={loading}>
        {loading ? 'Registrando…' : 'Registrar usuario'}
      </button>
      {notice && <p className="status-ok">{notice}</p>}
      {error && <p className="error-text">{error}</p>}
    </form>
  );
}
