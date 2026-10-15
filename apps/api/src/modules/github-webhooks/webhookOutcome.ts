/** Qué pasó con un webhook ya autenticado. Cada rama de los handlers devuelve uno, así el
 * registro de entregas puede decir POR QUÉ un evento no produjo un análisis en vez de que
 * el motivo quede enterrado en el log del contenedor. */
export interface WebhookOutcome {
  outcome: 'processed' | 'ignored' | 'error';
  /** Código corto y estable (la interfaz lo traduce); ver REASONS en la página de webhooks. */
  reason: string;
  detail?: string;
  action?: string;
  repository?: string;
  ref?: string;
  commitSha?: string;
  reviewRunId?: string;
}

export const processed = (reason: string, rest: Omit<WebhookOutcome, 'outcome' | 'reason'> = {}): WebhookOutcome => ({
  outcome: 'processed',
  reason,
  ...rest,
});

export const ignored = (reason: string, rest: Omit<WebhookOutcome, 'outcome' | 'reason'> = {}): WebhookOutcome => ({
  outcome: 'ignored',
  reason,
  ...rest,
});
