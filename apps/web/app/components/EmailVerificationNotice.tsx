'use client';

import { useState } from 'react';
import { apiJson } from '../lib/clientApi';

export function EmailVerificationNotice() {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'not_sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function resend() {
    setState('sending');
    setError(null);
    try {
      const { sent } = await apiJson<{ sent: boolean }>('/api/auth/resend-verification', { method: 'POST' });
      setState(sent ? 'sent' : 'not_sent');
    } catch (err) {
      setError((err as Error).message);
      setState('idle');
    }
  }

  return (
    <div className="reauth-panel">
      <p style={{ marginTop: 0 }}>
        <strong>Tu correo todavía no está verificado.</strong> Hasta que lo confirmes no podrás recuperar tu cuenta por correo ni
        recibirás avisos de seguridad (por ejemplo, cuando se agregue una passkey).
      </p>
      <button type="button" onClick={resend} disabled={state === 'sending' || state === 'sent'}>
        {state === 'sending' ? 'Enviando…' : 'Enviarme el correo de verificación'}
      </button>
      {state === 'sent' && <p className="status-ok">Listo: revisa tu bandeja de entrada (y spam). El enlace vale 24 horas.</p>}
      {state === 'not_sent' && (
        <p className="error-text">No se pudo enviar: el servidor de correo (SMTP) no está configurado. Pídele a un administrador que lo configure en Configuración.</p>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
