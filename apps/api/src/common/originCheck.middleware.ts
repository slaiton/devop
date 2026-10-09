import type { NextFunction, Request, Response } from 'express';

/** Defensa en profundidad contra CSRF además de SameSite: una petición que cambia estado y
 * trae header `Origin` solo se acepta si es el de este despliegue. Los navegadores siempre
 * mandan `Origin` en POST/PATCH/PUT/DELETE entre sitios; las llamadas sin `Origin`
 * (webhooks de GitHub, renderizado del servidor de Next) no son de un navegador y pasan. */
export function originCheck(allowedOrigins: string[]) {
  const allowed = new Set(allowedOrigins);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const origin = req.headers.origin;
    if (!origin || allowed.has(origin)) return next();
    res.status(403).json({ statusCode: 403, message: 'origen no permitido' });
  };
}
