'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const TICK_MS = 30_000;
/** Se renueva cuando el token tiene más de esto de emitido y hubo actividad reciente. */
const RENEW_AFTER_MS = 30 * 60_000;
const ACTIVE_WITHIN_MS = 15 * 60_000;
const WARN_BEFORE_MS = 10 * 60_000;

/** Mantiene viva la sesión mientras la persona usa la app: renueva el token en segundo plano (nunca por la
 * simple apertura de la pestaña) y, si de verdad se va a vencer porque no hubo actividad, avisa con tiempo.
 * Si la sesión ya no se puede renovar (vencida, revocada o llegó al tope), manda al inicio de sesión. */
export function SessionKeeper({ expiresAt: initialExpiresAt, ttlMs }: { expiresAt: number | null; ttlMs: number | null }) {
  const [expiresAt, setExpiresAt] = useState<number | null>(initialExpiresAt);
  const [now, setNow] = useState(() => Date.now());
  const lastActivity = useRef(Date.now());
  const refreshing = useRef(false);

  const goToLogin = useCallback(() => {
    window.location.href = '/';
  }, []);

  const refresh = useCallback(async (): Promise<boolean> => {
    if (refreshing.current) return false;
    refreshing.current = true;
    try {
      const res = await fetch('/api/auth/refresh', { method: 'POST', cache: 'no-store' });
      if (res.status === 401 || res.status === 403) {
        goToLogin();
        return false;
      }
      if (!res.ok) return false; // fallo transitorio: se reintenta en el siguiente ciclo
      const body = (await res.json()) as { expiresAt: number };
      setExpiresAt(body.expiresAt);
      setNow(Date.now());
      return true;
    } catch {
      return false;
    } finally {
      refreshing.current = false;
    }
  }, [goToLogin]);

  useEffect(() => {
    let last = 0;
    const mark = () => {
      const t = Date.now();
      if (t - last > 5_000) {
        last = t;
        lastActivity.current = t;
      }
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    events.forEach((e) => window.addEventListener(e, mark, { passive: true }));
    const onVisible = () => {
      if (document.visibilityState === 'visible') mark();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      events.forEach((e) => window.removeEventListener(e, mark));
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  useEffect(() => {
    if (!expiresAt || !ttlMs) return;
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      const issuedAt = expiresAt - ttlMs;
      if (t >= expiresAt) {
        // Otra pestaña pudo haber renovado la cookie: intenta renovar antes de dar la sesión por perdida.
        void refresh().then((ok) => {
          if (!ok) goToLogin();
        });
        return;
      }
      if (t - issuedAt > RENEW_AFTER_MS && t - lastActivity.current < ACTIVE_WITHIN_MS) void refresh();
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [expiresAt, ttlMs, refresh, goToLogin]);

  if (!expiresAt || expiresAt - now > WARN_BEFORE_MS) return null;
  const minutes = Math.max(1, Math.ceil((expiresAt - now) / 60_000));
  return (
    <div className="session-banner" role="status" aria-live="polite">
      <span>Tu sesión vence en {minutes} min por inactividad.</span>
      <button type="button" onClick={() => void refresh()}>
        Seguir conectado
      </button>
    </div>
  );
}
