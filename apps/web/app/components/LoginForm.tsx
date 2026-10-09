'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { browserSupportsWebAuthn, browserSupportsWebAuthnAutofill, startAuthentication } from '@simplewebauthn/browser';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { AlertCircleIcon, PasskeyIcon } from './icons';
import { apiJson, describeWebAuthnError, isAbort } from '../lib/clientApi';

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [passkeySupported, setPasskeySupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autofillStarted = useRef(false);

  async function signInWithPasskey(useBrowserAutofill: boolean) {
    const { options } = await apiJson<{ options: PublicKeyCredentialRequestOptionsJSON }>('/api/auth/passkey/options', { method: 'POST' });
    const response = await startAuthentication({ optionsJSON: options, useBrowserAutofill });
    await apiJson('/api/auth/passkey/verify', { method: 'POST', body: { response } });
    router.push('/');
    router.refresh();
  }

  // Passkey primero: si el navegador lo soporta, el campo de correo ofrece las passkeys
  // guardadas en el autocompletado (conditional UI) sin tocar ningún botón.
  useEffect(() => {
    if (!browserSupportsWebAuthn()) return;
    setPasskeySupported(true);
    if (autofillStarted.current) return;
    autofillStarted.current = true;
    browserSupportsWebAuthnAutofill()
      .then((supported) => (supported ? signInWithPasskey(true) : undefined))
      .catch((err) => {
        // Cancelar o pisar la ceremonia de autocompletado (p. ej. al pulsar el botón) no es un error.
        if (!isAbort(err)) setError(describeWebAuthnError(err));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handlePasskeyClick() {
    setError(null);
    setPasskeyLoading(true);
    try {
      await signInWithPasskey(false);
    } catch (err) {
      setError(describeWebAuthnError(err));
      setPasskeyLoading(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await apiJson('/api/auth/login', { method: 'POST', body: { email, password } });
      router.push('/');
      router.refresh();
    } catch (err) {
      setError((err as Error).message || 'correo o contraseña incorrectos');
      setLoading(false);
    }
  }

  return (
    <div className="login-form">
      {error && (
        <div className="login-error">
          <AlertCircleIcon width={15} height={15} />
          <span>{error}</span>
        </div>
      )}

      {passkeySupported && (
        <>
          <button type="button" className="btn-primary" onClick={handlePasskeyClick} disabled={passkeyLoading || loading}>
            <PasskeyIcon width={18} height={18} />
            {passkeyLoading ? 'Verificando…' : 'Entrar con passkey'}
          </button>
          <p className="login-hint">Usa tu huella, rostro o el PIN de este dispositivo — sin escribir contraseña.</p>
          <div className="login-divider">
            <span>o con tu contraseña</span>
          </div>
        </>
      )}

      <form className="login-form" onSubmit={handleSubmit}>
        <label>
          Correo electrónico
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username webauthn"
            required
          />
        </label>
        <label>
          Contraseña
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <button type="submit" className={passkeySupported ? 'btn-secondary' : 'btn-primary'} disabled={loading || passkeyLoading}>
          {loading ? 'Ingresando…' : 'Iniciar sesión con contraseña'}
        </button>
      </form>

      <Link href="/forgot-password" className="login-link">
        ¿Olvidaste tu contraseña?
      </Link>
    </div>
  );
}
