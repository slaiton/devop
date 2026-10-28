'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { audioState, playSound, unlockAudio } from '../lib/sounds';

interface ReviewEvent {
  type: 'review_completed' | 'review_failed';
  reviewRunId: string;
  repository: string;
  branch: string | null;
  commitSha: string;
  trigger: string;
  prNumber: number | null;
  gate: 'apto' | 'requiere_revision' | 'no_apto' | null;
  score: number | null;
  blockingCount: number;
  questionCount?: number;
  author: { name: string | null };
  sound: { id: string; volume: number; muted: boolean };
}

interface Toast {
  key: string;
  event: ReviewEvent;
}

const STORAGE_SOUND = 'ds.notify.sound';
const STORAGE_DESKTOP = 'ds.notify.desktop';
const TOAST_MS = 12_000;

const read = (key: string, fallback: boolean): boolean => {
  try {
    const v = window.localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
};
const write = (key: string, value: boolean) => {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // sin almacenamiento (modo privado): la preferencia vale solo para esta pestaña
  }
};

const GATE_LABEL: Record<string, string> = { apto: '✓ APTO', requiere_revision: '⚠ REQUIERE REVISIÓN', no_apto: '✕ NO APTO' };

function describe(e: ReviewEvent): { title: string; detail: string } {
  const where = `${e.repository} · ${e.trigger === 'pull_request' && e.prNumber ? `PR #${e.prNumber}` : (e.branch ?? e.commitSha.slice(0, 7))}`;
  const who = e.author.name ? ` · ${e.author.name}` : '';
  if (e.type === 'review_failed') return { title: 'No se pudo analizar un commit', detail: `${where}${who}` };
  const score = e.score !== null ? ` · ${e.score}/100` : '';
  const questions = e.questionCount ? ` · ❓ ${e.questionCount} pregunta${e.questionCount === 1 ? '' : 's'} de la IA` : '';
  return { title: `${GATE_LABEL[e.gate ?? ''] ?? 'Análisis terminado'}${score}`, detail: `${where}${who}${questions}` };
}

/** Aviso en vivo de los análisis que terminan: aviso emergente + sonido (el tono que el admin asignó al AUTOR del commit)
 * y, si la pestaña está en segundo plano, notificación del navegador. Un admin recibe los de todos los desarrolladores;
 * un desarrollador, los de sus commits. Las preferencias (sonido, notificaciones del navegador) son por navegador. */
export function NotificationCenter({ isAdmin }: { isAdmin: boolean }) {
  const [soundOn, setSoundOn] = useState(true);
  const [desktopOn, setDesktopOn] = useState(false);
  const [audio, setAudio] = useState<'unsupported' | 'locked' | 'ready'>('locked');
  const [connected, setConnected] = useState(false);
  const [open, setOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const soundOnRef = useRef(true);
  const desktopOnRef = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const s = read(STORAGE_SOUND, true);
    const d = read(STORAGE_DESKTOP, false) && typeof Notification !== 'undefined' && Notification.permission === 'granted';
    setSoundOn(s);
    setDesktopOn(d);
    soundOnRef.current = s;
    desktopOnRef.current = d;
    setAudio(audioState());
  }, []);

  // El navegador solo permite audio tras un gesto del usuario: el primer clic o tecla de la sesión lo habilita.
  useEffect(() => {
    const unlock = () => {
      void unlockAudio().then(() => setAudio(audioState()));
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  const handle = useCallback((event: ReviewEvent) => {
    const key = `${event.reviewRunId}-${Date.now()}`;
    setToasts((t) => [{ key, event }, ...t].slice(0, 4));
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.key !== key)), TOAST_MS);

    if (soundOnRef.current && !event.sound.muted) {
      const repeats = event.gate === 'no_apto' || event.type === 'review_failed' ? 2 : 1;
      playSound(event.sound.id, event.sound.volume, repeats);
    }
    if (desktopOnRef.current && document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const { title, detail } = describe(event);
      try {
        const n = new Notification(title, { body: detail, tag: event.reviewRunId });
        n.onclick = () => {
          window.focus();
          window.location.href = `/review-runs/${event.reviewRunId}`;
          n.close();
        };
      } catch {
        // algunos navegadores móviles solo permiten notificaciones desde un service worker
      }
    }
  }, []);

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let source: EventSource | null = null;
    let retry: number | undefined;
    let stopped = false;

    const connect = () => {
      source = new EventSource('/api/notifications/stream');
      source.addEventListener('ready', () => setConnected(true));
      source.addEventListener('review', (e) => {
        try {
          handle(JSON.parse((e as MessageEvent).data) as ReviewEvent);
        } catch {
          // evento mal formado: se ignora
        }
      });
      source.onerror = () => {
        setConnected(false);
        // EventSource reconecta solo mientras la conexión no se haya cerrado del todo. Si se cerró (p. ej. la sesión
        // venció y el servidor respondió 401), se intenta renovar la sesión y se vuelve a conectar.
        if (source && source.readyState === EventSource.CLOSED && !stopped) {
          source.close();
          retry = window.setTimeout(async () => {
            try {
              const res = await fetch('/api/auth/refresh', { method: 'POST', cache: 'no-store' });
              if (res.ok && !stopped) connect();
            } catch {
              if (!stopped) connect();
            }
          }, 5_000);
        }
      };
    };
    connect();
    return () => {
      stopped = true;
      window.clearTimeout(retry);
      source?.close();
    };
  }, [handle]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);

  const toggleSound = async () => {
    const next = !soundOn;
    setSoundOn(next);
    soundOnRef.current = next;
    write(STORAGE_SOUND, next);
    if (next) {
      await unlockAudio();
      setAudio(audioState());
    }
  };

  const toggleDesktop = async () => {
    if (desktopOn) {
      setDesktopOn(false);
      desktopOnRef.current = false;
      write(STORAGE_DESKTOP, false);
      return;
    }
    if (typeof Notification === 'undefined') return;
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    const on = permission === 'granted';
    setDesktopOn(on);
    desktopOnRef.current = on;
    write(STORAGE_DESKTOP, on);
  };

  const test = async () => {
    await unlockAudio();
    setAudio(audioState());
    playSound('campana', 0.8);
  };

  const needsGesture = soundOn && audio === 'locked';
  const desktopBlocked = typeof Notification !== 'undefined' && Notification.permission === 'denied';

  return (
    <>
      <div className="notify" ref={panelRef}>
        <button
          type="button"
          className={`notify-bell${needsGesture ? ' notify-bell-pending' : ''}`}
          onClick={() => setOpen((v) => !v)}
          aria-label={soundOn ? 'Avisos de análisis: activados' : 'Avisos de análisis: sonido silenciado'}
          aria-expanded={open}
          aria-haspopup="true"
        >
          <span aria-hidden="true">{soundOn ? '🔔' : '🔕'}</span>
          {needsGesture && <span className="notify-dot" aria-hidden="true" />}
        </button>
        {open && (
          <div className="notify-panel" role="dialog" aria-label="Avisos de análisis">
            <p className="notify-title">Avisos de análisis</p>
            <p className="notify-hint">
              {isAdmin
                ? 'Suena cuando termina el análisis de un commit, con el tono que asignaste a su autor.'
                : 'Suena cuando termina el análisis de uno de tus commits, con el tono que te asignó el admin.'}
            </p>
            <label className="notify-row">
              <input type="checkbox" checked={soundOn} onChange={() => void toggleSound()} />
              Sonido en este navegador
            </label>
            {needsGesture && <p className="notify-warn">Haz clic en cualquier parte de la página para que el navegador permita el sonido.</p>}
            {audio === 'unsupported' && <p className="notify-warn">Este navegador no permite reproducir audio.</p>}
            <label className="notify-row">
              <input type="checkbox" checked={desktopOn} onChange={() => void toggleDesktop()} disabled={desktopBlocked || typeof Notification === 'undefined'} />
              Notificación del navegador (cuando esta pestaña está en segundo plano)
            </label>
            {desktopBlocked && <p className="notify-warn">Las notificaciones están bloqueadas: habilítalas desde los permisos del sitio en tu navegador.</p>}
            <div className="notify-actions">
              <button type="button" onClick={() => void test()}>Probar sonido</button>
              <span className={connected ? 'status-ok' : 'status-warn'} role="status">{connected ? '● Conectado' : '○ Reconectando…'}</span>
            </div>
          </div>
        )}
      </div>

      <div className="toast-stack" aria-live="polite">
        {toasts.map(({ key, event }) => {
          const { title, detail } = describe(event);
          const cls = event.type === 'review_failed' || event.gate === 'no_apto' ? 'toast-bad' : event.gate === 'requiere_revision' ? 'toast-warn' : 'toast-ok';
          return (
            <Link key={key} href={`/review-runs/${event.reviewRunId}`} className={`toast ${cls}`} onClick={() => setToasts((t) => t.filter((x) => x.key !== key))}>
              <strong>{title}</strong>
              <span>{detail}</span>
            </Link>
          );
        })}
      </div>
    </>
  );
}
