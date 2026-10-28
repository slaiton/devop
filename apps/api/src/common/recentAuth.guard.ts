import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { RequestWithSession } from './jwtAuth.guard';

export const RECENT_AUTH_WINDOW_SECONDS = 5 * 60;

/** Corre después de JwtAuthGuard. Las acciones que cambian cómo se entra a la cuenta
 * (agregar o borrar una passkey) exigen haberse autenticado hace pocos minutos: una sesión
 * robada o un navegador desatendido no alcanza para registrar el autenticador del atacante.
 * El front responde al código REAUTH_REQUIRED pidiendo contraseña o passkey. */
@Injectable()
export class RecentAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const session = context.switchToHttp().getRequest<RequestWithSession>().session;
    // `at` = última autenticación real (una renovación de sesión no lo toca); sin él, `iat`.
    const ageSeconds = Math.floor(Date.now() / 1000) - (session?.at ?? session?.iat ?? 0);
    if (ageSeconds > RECENT_AUTH_WINDOW_SECONDS) {
      throw new ForbiddenException({ code: 'REAUTH_REQUIRED', message: 'confirma tu identidad para continuar' });
    }
    return true;
  }
}
