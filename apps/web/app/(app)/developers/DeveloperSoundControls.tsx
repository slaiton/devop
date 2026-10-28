'use client';

import { useEffect, useRef, useState } from 'react';
import { playSound, unlockAudio } from '../../lib/sounds';

export interface SoundOption {
  id: string;
  label: string;
}

/** Tono, volumen y silencio del aviso sonoro de UN desarrollador. Guarda solo, al cambiar. */
export function DeveloperSoundControls({
  developerId,
  sounds,
  defaultSound,
  initial,
}: {
  developerId: string;
  sounds: SoundOption[];
  defaultSound: string;
  initial: { sound: string | null; volume: number; muted: boolean };
}) {
  const [sound, setSound] = useState<string>(initial.sound ?? '');
  const [volume, setVolume] = useState(Math.round(initial.volume * 100));
  const [muted, setMuted] = useState(initial.muted);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function save(patch: { sound?: string | null; volume?: number; muted?: boolean }) {
    setStatus('saving');
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/developers/${developerId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(Array.isArray(body.message) ? body.message.join(', ') : (body.message ?? `error ${res.status}`));
      }
      setStatus('saved');
    } catch (err) {
      setStatus('error');
      setError((err as Error).message);
    }
  }

  async function preview(id = sound || defaultSound, vol = volume) {
    await unlockAudio();
    playSound(id, vol / 100);
  }

  const label = sounds.find((s) => s.id === (sound || defaultSound))?.label ?? sound;

  return (
    <div className="dev-sound">
      <label className="dev-sound-field">
        <span className="dev-sound-label">Tono</span>
        <select
          value={sound}
          aria-label="Tono de aviso"
          onChange={(e) => {
            setSound(e.target.value);
            void save({ sound: e.target.value || null });
            void preview(e.target.value || defaultSound);
          }}
        >
          <option value="">Por defecto ({sounds.find((s) => s.id === defaultSound)?.label ?? defaultSound})</option>
          {sounds.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <label className="dev-sound-field">
        <span className="dev-sound-label">Volumen {volume}%</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={volume}
          aria-label="Volumen del aviso"
          onChange={(e) => {
            const v = Number(e.target.value);
            setVolume(v);
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => void save({ volume: v / 100 }), 400);
          }}
          onPointerUp={() => void preview()}
        />
      </label>
      <label className="dev-sound-field dev-sound-inline">
        <input
          type="checkbox"
          checked={muted}
          onChange={(e) => {
            setMuted(e.target.checked);
            void save({ muted: e.target.checked });
          }}
        />
        Silenciado
      </label>
      <button type="button" className="ready-link" onClick={() => void preview()} aria-label={`Escuchar ${label}`}>
        ▶ Escuchar
      </button>
      <span className={status === 'error' ? 'error-text' : 'status-ok'} role="status" aria-live="polite">
        {status === 'saving' ? 'Guardando…' : status === 'saved' ? '✓ Guardado' : status === 'error' ? error : ''}
      </span>
    </div>
  );
}
