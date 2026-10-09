'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { AlertCircleIcon } from './icons';
import { apiJson } from '../lib/clientApi';

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="login-error">
      <AlertCircleIcon width={15} height={15} />
      <span>{message}</span>
    </div>
  );
}

/** Requiere un clic en vez de confirmar al cargar la página: algunos filtros de correo "abren"
 * los enlaces para escanearlos y gastarían el token de un solo uso antes que la persona. */
export function VerifyEmailForm({ token }: { token: string | null }) {
  const [state, setState] = useState<'idle' | 'working' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  if (!token) return <ErrorBox message="Falta el enlace de verificación. Abre el enlace completo del correo." />;

  async function confirm() {
    setState('working');
    setError(null);
    try {
      await apiJson('/api/auth/verify-email', { method: 'POST', body: { token } });
      setState('done');
    } catch (err) {
      setError((err as Error).message);
      setState('idle');
    }
  }

  if (state === 'done') {
    return (
      <>
        <div className="login-ok">¡Listo! Tu correo quedó verificado.</div>
        <Link href="/" className="btn-primary">
          Ir a DevSentinel
        </Link>
      </>
    );
  }
  return (
    <div className="login-form">
      {error && <ErrorBox message={error} />}
      <button type="button" className="btn-primary" onClick={confirm} disabled={state === 'working'}>
        {state === 'working' ? 'Confirmando…' : 'Confirmar mi correo'}
      </button>
    </div>
  );
}

export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await apiJson('/api/auth/recover/request', { method: 'POST', body: { email } });
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <>
        <div className="login-ok">
          Si ese correo está registrado y verificado, te enviamos un enlace para elegir una contraseña nueva (vale 15 minutos). Revisa
          también el spam.
        </div>
        <Link href="/" className="login-link">
          Volver al inicio de sesión
        </Link>
      </>
    );
  }
  return (
    <form className="login-form" onSubmit={submit}>
      {error && <ErrorBox message={error} />}
      <label>
        Correo electrónico
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
      </label>
      <button type="submit" className="btn-primary" disabled={loading}>
        {loading ? 'Enviando…' : 'Enviarme el enlace'}
      </button>
      <p className="login-hint">
        Si eres administrador, pídele a otro administrador que restablezca tu acceso: por seguridad no se hace solo por correo.
      </p>
      <Link href="/" className="login-link">
        Volver al inicio de sesión
      </Link>
    </form>
  );
}

export function ResetPasswordForm({ token }: { token: string | null }) {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!token) return <ErrorBox message="Falta el enlace de recuperación. Abre el enlace completo del correo." />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await apiJson('/api/auth/recover/complete', { method: 'POST', body: { token, newPassword: password } });
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <>
        <div className="login-ok">Contraseña actualizada. Ya puedes iniciar sesión (tus otras sesiones se cerraron).</div>
        <Link href="/" className="btn-primary">
          Iniciar sesión
        </Link>
      </>
    );
  }
  return (
    <form className="login-form" onSubmit={submit}>
      {error && <ErrorBox message={error} />}
      <label>
        Contraseña nueva (mínimo 8 caracteres)
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          minLength={8}
          required
        />
      </label>
      <button type="submit" className="btn-primary" disabled={loading}>
        {loading ? 'Guardando…' : 'Guardar contraseña'}
      </button>
    </form>
  );
}
