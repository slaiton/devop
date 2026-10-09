import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { getPool } from '@devsentinel/database';
import { EmailService } from '../../common/email.service';
import type { ClientInfo } from '../../common/session';
import { consumeAccountToken, createAccountToken } from './accountTokens';
import { AuthService } from './auth.service';
import { SecurityEventsService } from './securityEvents.service';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const VERIFY_TTL_MINUTES = 24 * 60;
const RESET_TTL_MINUTES = 15;

/** Verificación de correo y recuperación de contraseña por enlace de un solo uso. Un
 * correo sin verificar no sirve para recuperar la cuenta ni para recibir avisos de
 * seguridad: podría ser de otra persona. */
@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private readonly auth: AuthService,
    private readonly events: SecurityEventsService,
    private readonly email: EmailService,
  ) {}

  private webOrigin(): string {
    return (process.env.PUBLIC_WEB_ORIGIN ?? '').replace(/\/+$/, '');
  }

  private async sendMail(to: string, subject: string, bodyHtml: string): Promise<boolean> {
    try {
      await this.email.send({ to, subject, html: `<div style="font-family:sans-serif;max-width:520px">${bodyHtml}<p style="color:#888;font-size:12px">DevSentinel AI</p></div>` });
      return true;
    } catch (err) {
      this.logger.warn(`no se pudo enviar el correo '${subject}': ${(err as Error).message}`);
      return false;
    }
  }

  /** Devuelve false (sin lanzar) si no se pudo enviar — p. ej. SMTP sin configurar —
   * para que crear un usuario no falle por eso; el admin puede reenviar después. */
  async sendVerificationEmail(userId: string): Promise<boolean> {
    const { rows } = await getPool().query('SELECT email, name, email_verified_at FROM users WHERE id = $1', [userId]);
    const user = rows[0];
    if (!user?.email || user.email_verified_at) return false;
    const origin = this.webOrigin();
    if (!origin) {
      this.logger.warn('PUBLIC_WEB_ORIGIN no está definido: no se puede armar el enlace de verificación');
      return false;
    }
    const token = await createAccountToken(userId, 'verify_email', VERIFY_TTL_MINUTES);
    const link = `${origin}/verify-email?token=${encodeURIComponent(token)}`;
    return this.sendMail(
      user.email,
      'Confirma tu correo — DevSentinel AI',
      `<p>Hola ${escapeHtml(user.name ?? '')},</p>
       <p>Confirma que este correo es tuyo para poder recuperar tu cuenta y recibir avisos de seguridad:</p>
       <p><a href="${link}">Confirmar mi correo</a></p>
       <p>El enlace vale 24 horas y solo se puede usar una vez.</p>`,
    );
  }

  async verifyEmail(rawToken: string, client?: ClientInfo): Promise<void> {
    const userId = rawToken ? await consumeAccountToken(rawToken, 'verify_email') : null;
    if (!userId) throw new BadRequestException('el enlace no es válido o ya venció');
    await getPool().query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1', [userId]);
    await this.events.record(userId, 'email_verified', client);
  }

  /** Siempre responde igual, exista o no el correo, para no revelar quién está registrado.
   * Los admins quedan fuera a propósito: restablecer la contraseña de un admin solo por
   * correo convertiría una casilla comprometida en control de toda la organización; para
   * ellos la recuperación la hace otro admin desde Usuarios. */
  async requestPasswordReset(emailAddress: string, client?: ClientInfo): Promise<void> {
    const { rows } = await getPool().query(
      'SELECT id, email, name, email_verified_at FROM users WHERE lower(email) = lower($1)',
      [(emailAddress ?? '').trim()],
    );
    const user = rows[0];
    if (!user) return;
    if (!user.email_verified_at) {
      await this.events.record(user.id, 'recover_ignored_unverified', client);
      return;
    }
    const { rows: adminRows } = await getPool().query('SELECT user_has_admin_role($1) AS is_admin', [user.id]);
    if (adminRows[0]?.is_admin) {
      await this.events.record(user.id, 'recover_ignored_admin', client);
      return;
    }
    const origin = this.webOrigin();
    if (!origin) return;

    const token = await createAccountToken(user.id, 'reset_password', RESET_TTL_MINUTES);
    await this.events.record(user.id, 'recover_requested', client);
    await this.sendMail(
      user.email,
      'Restablecer tu contraseña — DevSentinel AI',
      `<p>Hola ${escapeHtml(user.name ?? '')},</p>
       <p>Recibimos una solicitud para restablecer tu contraseña. Si fuiste tú:</p>
       <p><a href="${origin}/reset-password?token=${encodeURIComponent(token)}">Elegir una contraseña nueva</a></p>
       <p>El enlace vale ${RESET_TTL_MINUTES} minutos y solo se puede usar una vez. Si no lo pediste, ignora este correo: tu contraseña no cambia.</p>`,
    );
  }

  async completePasswordReset(rawToken: string, newPassword: string, client?: ClientInfo): Promise<void> {
    this.auth.assertValidNewPassword(newPassword);
    const userId = rawToken ? await consumeAccountToken(rawToken, 'reset_password') : null;
    if (!userId) throw new BadRequestException('el enlace no es válido o ya venció');

    const newHash = await this.auth.hashPassword(newPassword);
    // Subir session_version cierra toda sesión abierta (incluida la de quien hubiera
    // robado la contraseña vieja).
    const { rows } = await getPool().query(
      `UPDATE users
       SET password_hash = $1, must_change_password = false, session_version = session_version + 1,
           failed_login_attempts = 0, locked_until = NULL
       WHERE id = $2 RETURNING email, name, email_verified_at`,
      [newHash, userId],
    );
    await this.events.record(userId, 'password_reset', client);
    const user = rows[0];
    if (user?.email && user.email_verified_at) {
      await this.sendMail(
        user.email,
        'Tu contraseña fue restablecida — DevSentinel AI',
        `<p>Hola ${escapeHtml(user.name ?? '')},</p><p>La contraseña de tu cuenta se restableció y se cerraron tus sesiones abiertas. Si no fuiste tú, avisa a un administrador de inmediato.</p>`,
      );
    }
  }

  /** Aviso de cambio en los métodos de acceso (passkey agregada/borrada). Solo a correos
   * verificados; un fallo de envío nunca debe impedir la operación. */
  async notifyAccessChange(userId: string, subject: string, detailHtml: string): Promise<void> {
    const { rows } = await getPool().query('SELECT email, name, email_verified_at FROM users WHERE id = $1', [userId]);
    const user = rows[0];
    if (!user?.email || !user.email_verified_at) return;
    await this.sendMail(
      user.email,
      `${subject} — DevSentinel AI`,
      `<p>Hola ${escapeHtml(user.name ?? '')},</p><p>${detailHtml}</p><p>Si no fuiste tú, cambia tu contraseña y avisa a un administrador de inmediato.</p>`,
    );
  }
}
