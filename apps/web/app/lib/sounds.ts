/** Motor de sonidos de aviso: sintetiza cada tono con WebAudio (sin archivos de audio ni licencias). Los ids deben
 * coincidir con el catálogo de la API (apps/api/src/modules/notifications/sounds.ts); un id desconocido cae al
 * tono por defecto. Los navegadores solo dejan reproducir audio tras un gesto del usuario (un clic o una tecla),
 * por eso `unlockAudio()` se engancha al primer gesto de la sesión. */

export const DEFAULT_SOUND = 'campana';

type Wave = OscillatorType;
interface Tone {
  at: number; // segundos desde el inicio del patrón
  freq: number;
  dur: number;
  type?: Wave;
  gain?: number;
  endFreq?: number; // glissando
}

const PATTERNS: Record<string, Tone[]> = {
  campana: [
    { at: 0, freq: 880, dur: 1.1, gain: 0.9 },
    { at: 0, freq: 2217, dur: 0.7, gain: 0.3 },
    { at: 0, freq: 1320, dur: 0.9, gain: 0.25 },
  ],
  ding: [{ at: 0, freq: 1318.5, dur: 0.5, gain: 1 }],
  arpegio: [523.25, 659.25, 783.99, 1046.5].map((freq, i) => ({ at: i * 0.14, freq, dur: 0.32, type: 'triangle' as Wave, gain: 0.8 })),
  marimba: [659.25, 880].flatMap((freq, i) => [
    { at: i * 0.15, freq, dur: 0.38, gain: 0.9 },
    { at: i * 0.15, freq: freq * 4, dur: 0.12, gain: 0.25 },
  ]),
  gota: [
    { at: 0, freq: 1400, endFreq: 520, dur: 0.22, gain: 0.9 },
    { at: 0.3, freq: 900, endFreq: 420, dur: 0.2, gain: 0.5 },
  ],
  moneda: [
    { at: 0, freq: 987.77, dur: 0.09, type: 'square', gain: 0.3 },
    { at: 0.09, freq: 1318.5, dur: 0.55, type: 'square', gain: 0.3 },
  ],
  pulso: [0, 0.18, 0.36].map((at) => ({ at, freq: 620, dur: 0.1, gain: 0.8 })),
  alerta: [740, 554.37, 740, 554.37].map((freq, i) => ({ at: i * 0.2, freq, dur: 0.18, type: 'triangle' as Wave, gain: 0.8 })),
  silencio: [],
};

export const SOUND_IDS = Object.keys(PATTERNS);

let context: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!context) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      context = new Ctor();
    } catch {
      return null;
    }
  }
  return context;
}

export type AudioState = 'unsupported' | 'locked' | 'ready';

export function audioState(): AudioState {
  const ctx = getContext();
  if (!ctx) return 'unsupported';
  return ctx.state === 'running' ? 'ready' : 'locked';
}

/** Habilita el audio (hay que llamarlo desde un gesto del usuario). Devuelve si quedó listo. */
export async function unlockAudio(): Promise<boolean> {
  const ctx = getContext();
  if (!ctx) return false;
  if (ctx.state !== 'running') {
    try {
      await ctx.resume();
    } catch {
      return false;
    }
  }
  return ctx.state === 'running';
}

function patternLength(tones: Tone[]): number {
  return tones.reduce((max, t) => Math.max(max, t.at + t.dur), 0);
}

/** Reproduce el tono `id` con el volumen 0..1 (`repeat` veces). Devuelve false si el audio no está disponible o está bloqueado. */
export function playSound(id: string, volume: number, repeat = 1): boolean {
  const ctx = getContext();
  if (!ctx || ctx.state !== 'running') return false;
  const tones = PATTERNS[id] ?? PATTERNS[DEFAULT_SOUND];
  if (tones.length === 0) return true; // "sin sonido": solo aviso visual
  const level = Math.min(1, Math.max(0, volume)) * 0.45; // margen para que varias notas juntas no saturen
  const length = patternLength(tones);
  const start = ctx.currentTime + 0.02;

  for (let r = 0; r < Math.max(1, repeat); r++) {
    const offset = start + r * (length + 0.25);
    for (const tone of tones) {
      const osc = ctx.createOscillator();
      const amp = ctx.createGain();
      osc.type = tone.type ?? 'sine';
      const t0 = offset + tone.at;
      osc.frequency.setValueAtTime(tone.freq, t0);
      if (tone.endFreq) osc.frequency.exponentialRampToValueAtTime(tone.endFreq, t0 + tone.dur);
      const peak = Math.max(0.0002, level * (tone.gain ?? 1));
      amp.gain.setValueAtTime(0.0001, t0);
      amp.gain.linearRampToValueAtTime(peak, t0 + 0.012);
      amp.gain.exponentialRampToValueAtTime(0.0001, t0 + tone.dur);
      osc.connect(amp).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + tone.dur + 0.05);
    }
  }
  return true;
}
