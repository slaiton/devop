import type { Request, Response } from 'express';

export const SESSION_COOKIE = 'session';
/** Cuánto vale un token sin renovarse (= inactividad máxima). Se renueva mientras la persona usa la app (POST /auth/refresh). */
export const SESSION_TTL_SECONDS = (Number(process.env.SESSION_TTL_HOURS) || 12) * 60 * 60;
export const SESSION_MAX_AGE_MS = SESSION_TTL_SECONDS * 1000; // igual al expiresIn del JWT (AuthService.issueSessionToken)
/** Tope absoluto desde la última autenticación real (contraseña o passkey): pasado esto, renovar ya no basta y hay que volver a entrar. */
export const SESSION_ABSOLUTE_MAX_SECONDS = (Number(process.env.SESSION_ABSOLUTE_MAX_DAYS) || 7) * 24 * 60 * 60;

// Secure cookies exigen HTTPS; en local (PUBLIC_WEB_ORIGIN=http://localhost) el
// navegador las descarta en silencio si quedan marcadas secure sobre HTTP plano.
export const COOKIES_REQUIRE_HTTPS = (process.env.PUBLIC_WEB_ORIGIN ?? '').startsWith('https://');

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIES_REQUIRE_HTTPS,
    maxAge: SESSION_MAX_AGE_MS,
  });
}

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

/** `req.ip` es la IP real del cliente solo porque main.ts activa `trust proxy` (Caddy
 * pone X-Forwarded-For); sin eso sería siempre la IP del proxy. */
export function clientInfo(req: Request): ClientInfo {
  return { ip: req.ip ?? null, userAgent: (req.headers['user-agent'] as string | undefined)?.slice(0, 300) ?? null };
}
