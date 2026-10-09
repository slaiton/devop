import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { compare, hash } from 'bcryptjs';
import { randomBytes } from 'crypto';
import { sign } from 'jsonwebtoken';
import { getPool, withTenant } from '@devsentinel/database';
import type { ClientInfo } from '../../common/session';
import { SecurityEventsService } from './securityEvents.service';

const BCRYPT_ROUNDS = 12;
export const MIN_PASSWORD_LENGTH = 8;
const MAX_FAILED_LOGINS = 10;
const LOCK_MINUTES = 15;
const GENERIC_LOGIN_ERROR = 'correo o contraseña incorrectos';

// Hash descartable para igualar el tiempo de respuesta cuando el correo no existe o la
// cuenta está bloqueada: sin esto, "no existe" respondería mucho más rápido que
// "contraseña incorrecta" y delataría qué correos están registrados.
const DUMMY_HASH = hash(randomBytes(16).toString('hex'), BCRYPT_ROUNDS);

export interface SessionTokenOptions {
  amr: 'pwd' | 'webauthn';
  sessionVersion: number;
  mustChangePassword?: boolean;
}

@Injectable()
export class AuthService {
  constructor(private readonly securityEvents: SecurityEventsService) {}

  async hashPassword(plain: string): Promise<string> {
    return hash(plain, BCRYPT_ROUNDS);
  }

  assertValidNewPassword(password: string | undefined): asserts password is string {
    if (!password || password.length < MIN_PASSWORD_LENGTH) {
      throw new BadRequestException(`la contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`);
    }
  }

  /** Login local: correo + contraseña contra `users.password_hash`. Mensaje de error
   * genérico en todos los casos (no existe / bloqueada / contraseña incorrecta) para no
   * filtrar qué correos están registrados. Tras 10 fallos seguidos la cuenta queda 15
   * minutos bloqueada — sin importar desde cuántas IPs lleguen los intentos. */
  async login(
    email: string,
    password: string,
    client?: ClientInfo,
  ): Promise<{ userId: string; sessionVersion: number; mustChangePassword: boolean }> {
    const { rows } = await getPool().query(
      `SELECT id, password_hash, session_version, must_change_password, failed_login_attempts, locked_until
       FROM users WHERE lower(email) = lower($1)`,
      [email.trim()],
    );
    const user = rows[0];

    if (!user?.password_hash) {
      await compare(password, await DUMMY_HASH);
      throw new UnauthorizedException(GENERIC_LOGIN_ERROR);
    }
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      await compare(password, await DUMMY_HASH);
      await this.securityEvents.record(user.id, 'login_blocked_locked', client);
      throw new UnauthorizedException(GENERIC_LOGIN_ERROR);
    }

    const ok = await compare(password, user.password_hash);
    if (!ok) {
      const { rows: updated } = await getPool().query(
        // Al bloquear, el contador vuelve a 0: pasados los 15 minutos la cuenta vuelve a
        // tener 10 intentos en vez de re-bloquearse al primer error.
        `UPDATE users
         SET failed_login_attempts = CASE WHEN failed_login_attempts + 1 >= $2 THEN 0 ELSE failed_login_attempts + 1 END,
             locked_until = CASE WHEN failed_login_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
         WHERE id = $1
         RETURNING (failed_login_attempts = 0) AS just_locked`,
        [user.id, MAX_FAILED_LOGINS, LOCK_MINUTES],
      );
      await this.securityEvents.record(user.id, updated[0]?.just_locked ? 'account_locked' : 'login_failed', client);
      throw new UnauthorizedException(GENERIC_LOGIN_ERROR);
    }

    if (user.failed_login_attempts > 0 || user.locked_until) {
      await getPool().query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1', [user.id]);
    }
    await this.securityEvents.record(user.id, 'login_password', client);
    return { userId: user.id as string, sessionVersion: user.session_version, mustChangePassword: user.must_change_password };
  }

  /** Reautenticación con contraseña (para acciones sensibles). No cuenta para el bloqueo
   * de la cuenta porque ya hay una sesión válida, pero igual deja rastro si falla. */
  async verifyPassword(userId: string, password: string, client?: ClientInfo): Promise<void> {
    const { rows } = await getPool().query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    const currentHash: string | null = rows[0]?.password_hash ?? null;
    if (!currentHash || !(await compare(password ?? '', currentHash))) {
      await this.securityEvents.record(userId, 'reauth_failed', client);
      throw new UnauthorizedException('la contraseña no es correcta');
    }
  }

  /** Cambia la contraseña, levanta la marca de "cambio pendiente" y sube la versión de
   * sesión (cierra las demás sesiones abiertas). Devuelve la versión nueva para que el
   * controller re-emita la cookie de la sesión actual. */
  async changePassword(userId: string, currentPassword: string, newPassword: string, client?: ClientInfo): Promise<number> {
    this.assertValidNewPassword(newPassword);
    const { rows } = await getPool().query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    const currentHash: string | null = rows[0]?.password_hash ?? null;
    if (currentHash) {
      const ok = await compare(currentPassword ?? '', currentHash);
      if (!ok) {
        await this.securityEvents.record(userId, 'password_change_failed', client);
        throw new UnauthorizedException('la contraseña actual no es correcta');
      }
    }
    const newHash = await this.hashPassword(newPassword);
    const { rows: updated } = await getPool().query(
      `UPDATE users
       SET password_hash = $1, must_change_password = false, session_version = session_version + 1,
           failed_login_attempts = 0, locked_until = NULL
       WHERE id = $2 RETURNING session_version`,
      [newHash, userId],
    );
    await this.securityEvents.record(userId, 'password_changed', client);
    return updated[0].session_version as number;
  }

  async getSessionState(userId: string): Promise<{ sessionVersion: number; mustChangePassword: boolean } | null> {
    const { rows } = await getPool().query('SELECT session_version, must_change_password FROM users WHERE id = $1', [userId]);
    if (!rows[0]) return null;
    return { sessionVersion: rows[0].session_version, mustChangePassword: rows[0].must_change_password };
  }

  /** org_memberships tiene RLS, así que resolver el tenant de un usuario sin conocerlo
   * aún exige la función SECURITY DEFINER creada en la migración 0012 (mismo patrón
   * que resolve_organization_for_installation). */
  async findOrganizationForUser(userId: string): Promise<string | null> {
    const { rows } = await getPool().query('SELECT resolve_organization_for_user($1) AS organization_id', [userId]);
    return rows[0]?.organization_id ?? null;
  }

  async getMembershipRole(organizationId: string, userId: string): Promise<string | null> {
    return withTenant(organizationId, async (client) => {
      const { rows } = await client.query(
        'SELECT role FROM org_memberships WHERE organization_id = $1 AND user_id = $2',
        [organizationId, userId],
      );
      return rows[0]?.role ?? null;
    });
  }

  /** Sesión corta a propósito: al expirar, `JwtAuthGuard` rechaza el token (401) y el
   * front trata eso como "no logueado" — la única forma de recuperar sesión es volver
   * a autenticarse (passkey o contraseña), sin refresh silencioso. */
  issueSessionToken(userId: string, organizationId: string, options: SessionTokenOptions): string {
    return sign(
      {
        sub: userId,
        orgId: organizationId,
        amr: options.amr,
        sv: options.sessionVersion,
        ...(options.mustChangePassword ? { mcp: true } : {}),
      },
      process.env.JWT_SECRET ?? '',
      { expiresIn: '4h' },
    );
  }
}
