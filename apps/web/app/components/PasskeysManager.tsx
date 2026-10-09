'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { ApiError, apiJson, describeWebAuthnError } from '../lib/clientApi';

interface Passkey {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  synced: boolean;
}

type PendingAction = { kind: 'add' } | { kind: 'delete'; passkey: Passkey };

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString();

export function PasskeysManager() {
  const [supported, setSupported] = useState(true);
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [password, setPassword] = useState('');

  const load = useCallback(async () => {
    try {
      setPasskeys(await apiJson<Passkey[]>('/api/auth/passkeys'));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    setSupported(browserSupportsWebAuthn());
    load();
  }, [load]);

  /** Ejecuta una acción sensible; si la API pide reautenticación (sesión con más de 5 min desde
   * el último ingreso) deja la acción en espera y muestra el panel para confirmar identidad. */
  async function run(action: PendingAction) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (action.kind === 'add') {
        const { options } = await apiJson<{ options: PublicKeyCredentialCreationOptionsJSON }>('/api/auth/passkeys/register/options', { method: 'POST' });
        const response = await startRegistration({ optionsJSON: options });
        await apiJson('/api/auth/passkeys/register/verify', { method: 'POST', body: { response } });
        setNotice('Passkey agregada. Te recomendamos registrar al menos dos (por ejemplo tu computador y tu teléfono).');
      } else {
        const { credentialId } = await apiJson<{ credentialId: string }>(`/api/auth/passkeys/${action.passkey.id}`, { method: 'DELETE' });
        // Le avisa al proveedor (iCloud, Google…) que esa passkey ya no existe, para que deje de ofrecerla.
        const pk = (window as unknown as { PublicKeyCredential?: { signalUnknownCredential?: (o: object) => Promise<void> } }).PublicKeyCredential;
        await pk?.signalUnknownCredential?.({ rpId: window.location.hostname, credentialId }).catch(() => undefined);
        setNotice('Passkey eliminada y sesiones anteriores cerradas.');
      }
      setPending(null);
      setPassword('');
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'REAUTH_REQUIRED') {
        setPending(action);
      } else if (err instanceof ApiError) {
        setPending(null);
        setError(err.message);
      } else {
        setPending(null);
        setError(describeWebAuthnError(err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function reauthWithPassword() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await apiJson('/api/auth/reauth', { method: 'POST', body: { password } });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
      return;
    }
    setBusy(false);
    await run(pending);
  }

  async function reauthWithPasskey() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      const { options } = await apiJson<{ options: PublicKeyCredentialRequestOptionsJSON }>('/api/auth/passkey/reauth/options', { method: 'POST' });
      const response = await startAuthentication({ optionsJSON: options });
      await apiJson('/api/auth/passkey/reauth/verify', { method: 'POST', body: { response } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : describeWebAuthnError(err));
      setBusy(false);
      return;
    }
    setBusy(false);
    await run(pending);
  }

  async function rename(passkey: Passkey) {
    const name = window.prompt('Nombre de la passkey', passkey.name)?.trim();
    if (!name || name === passkey.name) return;
    try {
      await apiJson(`/api/auth/passkeys/${passkey.id}`, { method: 'PATCH', body: { name } });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function confirmDelete(passkey: Passkey) {
    if (window.confirm(`¿Eliminar la passkey "${passkey.name}"? Se cerrarán tus otras sesiones abiertas.`)) {
      run({ kind: 'delete', passkey });
    }
  }

  if (!supported) {
    return <p style={{ color: 'var(--ink-muted)' }}>Este navegador no admite passkeys. Puedes seguir entrando con tu contraseña.</p>;
  }

  return (
    <div>
      {passkeys === null ? (
        <p>Cargando…</p>
      ) : passkeys.length === 0 ? (
        <p style={{ color: 'var(--ink-muted)' }}>
          Todavía no tienes passkeys. Con una passkey entras con tu huella, rostro o el PIN del dispositivo, sin escribir contraseña.
          Tu contraseña sigue funcionando como segunda opción.
        </p>
      ) : (
        <ul className="passkey-list">
          {passkeys.map((p) => (
            <li key={p.id} className="passkey-row">
              <div className="passkey-main">
                <div className="passkey-name">{p.name}</div>
                <div className="passkey-meta">
                  {p.synced ? 'Sincronizada en tu cuenta del proveedor' : 'Solo en este dispositivo'} · creada {fmtDate(p.created_at)} ·{' '}
                  {p.last_used_at ? `último uso ${fmtDate(p.last_used_at)}` : 'sin usar todavía'}
                </div>
              </div>
              <button type="button" onClick={() => rename(p)} disabled={busy}>
                Renombrar
              </button>
              <button type="button" onClick={() => confirmDelete(p)} disabled={busy}>
                Eliminar
              </button>
            </li>
          ))}
        </ul>
      )}

      {pending && (
        <form
          className="reauth-panel"
          onSubmit={(e) => {
            e.preventDefault();
            if (password) reauthWithPassword();
          }}
        >
          <p style={{ marginTop: 0 }}>
            <strong>Confirma que eres tú</strong> para {pending.kind === 'add' ? 'agregar una passkey' : 'eliminar esta passkey'}.
          </p>
          <p>
            <label>
              Contraseña
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </label>
          </p>
          <button type="submit" disabled={busy || !password}>
            Confirmar con contraseña
          </button>{' '}
          {passkeys && passkeys.length > 0 && (
            <button type="button" onClick={reauthWithPasskey} disabled={busy}>
              Confirmar con passkey
            </button>
          )}{' '}
          <button type="button" onClick={() => setPending(null)} disabled={busy}>
            Cancelar
          </button>
        </form>
      )}

      <p>
        <button type="button" onClick={() => run({ kind: 'add' })} disabled={busy || pending !== null}>
          {busy && !pending ? 'Esperando tu dispositivo…' : '+ Agregar passkey'}
        </button>
      </p>
      {notice && <p className="status-ok">{notice}</p>}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
