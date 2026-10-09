import type { Request, Response } from 'express';

export const SESSION_COOKIE = 'session';
export const SESSION_MAX_AGE_MS = 4 * 60 * 60 * 1000; // igual al expiresIn del JWT (AuthService.issueSessionToken)

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
