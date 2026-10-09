/** Helper para llamar a la API desde componentes de cliente. Conserva el `code` que manda la
 * API en los errores de reglas de negocio (REAUTH_REQUIRED, PASSWORD_CHANGE_REQUIRED) para
 * que la interfaz pueda reaccionar en vez de solo mostrar un mensaje. */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
  }
}

export async function apiJson<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = Array.isArray(data.message) ? data.message.join(', ') : data.message;
    throw new ApiError(message ?? `error ${res.status}`, res.status, data.code);
  }
  return data as T;
}

/** Traduce los errores del navegador durante una ceremonia WebAuthn a mensajes entendibles. */
export function describeWebAuthnError(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === 'NotAllowedError') return 'Cancelaste la verificación o se agotó el tiempo. Inténtalo de nuevo.';
  if (name === 'InvalidStateError') return 'Este dispositivo o proveedor ya tiene una passkey registrada para tu cuenta.';
  if (name === 'SecurityError') return 'El navegador bloqueó la passkey para este sitio (¿estás en HTTPS y en el dominio correcto?).';
  return (err as Error)?.message ?? 'No se pudo completar la verificación.';
}

export function isAbort(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === 'AbortError' || name === 'NotAllowedError';
}
