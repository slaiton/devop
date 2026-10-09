import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { verify } from 'jsonwebtoken';
import type { Request } from 'express';
import { getPool } from '@devsentinel/database';
import { ALLOW_PENDING_PASSWORD_CHANGE_KEY } from './allowPendingPasswordChange.decorator';
import { SESSION_COOKIE } from './session';

export interface SessionPayload {
  sub: string;
  orgId: string;
  role?: string;
  /** Momento (epoch s) en que se emitió = último momento de autenticación real, porque el
   * token solo se emite en login, reautenticación o cambio de contraseña. */
  iat?: number;
  /** Cómo se autenticó: contraseña o passkey. */
  amr?: 'pwd' | 'webauthn';
  /** Versión de sesión del usuario al emitirse; si subió (cambio de contraseña, passkeys
   * revocadas por un admin…) el token deja de valer. Tokens viejos sin `sv` cuentan como 0. */
  sv?: number;
  /** El usuario debe cambiar su contraseña antes de usar nada más. */
  mcp?: boolean;
}

export type RequestWithSession = Request & { session?: SessionPayload };

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithSession>();
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) {
      throw new UnauthorizedException('missing session cookie');
    }

    let session: SessionPayload;
    try {
      session = verify(token, process.env.JWT_SECRET ?? '') as SessionPayload;
    } catch {
      throw new UnauthorizedException('invalid or expired session');
    }

    // Un JWT es stateless: sin este chequeo no habría forma de cerrar una sesión robada ni
    // de revocar accesos al cambiar la contraseña o quitar passkeys.
    const { rows } = await getPool().query('SELECT session_version FROM users WHERE id = $1', [session.sub]);
    if (!rows[0] || rows[0].session_version !== (session.sv ?? 0)) {
      throw new UnauthorizedException('session revoked');
    }

    const allowedWhilePending = this.reflector.getAllAndOverride<boolean | undefined>(ALLOW_PENDING_PASSWORD_CHANGE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (session.mcp && !allowedWhilePending) {
      throw new ForbiddenException({ code: 'PASSWORD_CHANGE_REQUIRED', message: 'debes cambiar tu contraseña antes de continuar' });
    }

    req.session = session;
    return true;
  }
}
