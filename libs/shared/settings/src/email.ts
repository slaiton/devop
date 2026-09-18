import { createTransport } from 'nodemailer';
import type { Pool } from 'pg';
import { getSystemSettings } from './index';

export class SmtpNotConfiguredError extends Error {
  constructor() {
    super('SMTP no está configurado — no se puede enviar el correo (configúralo en /settings)');
  }
}

/** Envío de correo puro (sin dependencias de NestJS) para que tanto `api` como
 * `worker` puedan mandar notificaciones sin duplicar la lógica de nodemailer —
 * `apps/api/src/common/email.service.ts` es un wrapper delgado sobre esto. */
export async function sendEmail(pool: Pool, params: { to: string; subject: string; html: string }): Promise<void> {
  const settings = await getSystemSettings(pool);
  if (!settings?.smtpHost) {
    throw new SmtpNotConfiguredError();
  }

  const port = settings.smtpPort ?? 587;
  const transporter = createTransport({
    host: settings.smtpHost,
    port,
    secure: port === 465,
    auth: settings.smtpUser ? { user: settings.smtpUser, pass: settings.smtpPassword ?? undefined } : undefined,
  });

  await transporter.sendMail({
    from: settings.smtpFrom ?? 'DevSentinel AI <no-reply@devsentinel.local>',
    to: params.to,
    subject: params.subject,
    html: params.html,
  });
}
