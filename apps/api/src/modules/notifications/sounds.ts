/** Tonos de aviso disponibles. Los sintetiza el navegador (WebAudio), así que no hay archivos de audio: la
 * implementación de cada `id` está en apps/web/app/lib/sounds.ts. Un id desconocido en el navegador cae al tono por defecto. */
export const NOTIFICATION_SOUNDS = [
  { id: 'campana', label: 'Campana' },
  { id: 'ding', label: 'Ding' },
  { id: 'arpegio', label: 'Arpegio' },
  { id: 'marimba', label: 'Marimba' },
  { id: 'gota', label: 'Gota' },
  { id: 'moneda', label: 'Moneda' },
  { id: 'pulso', label: 'Pulso' },
  { id: 'alerta', label: 'Alerta suave' },
  { id: 'silencio', label: 'Sin sonido (solo aviso visual)' },
] as const;

export type NotificationSoundId = (typeof NOTIFICATION_SOUNDS)[number]['id'];
export const DEFAULT_NOTIFICATION_SOUND: NotificationSoundId = 'campana';

export const isNotificationSound = (value: unknown): value is NotificationSoundId =>
  typeof value === 'string' && NOTIFICATION_SOUNDS.some((s) => s.id === value);
