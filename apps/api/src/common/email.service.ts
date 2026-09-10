import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import { getPool } from '@devsentinel/database';
import { getSystemSettings } from '@devsentinel/settings';

@Injectable()
export class EmailService {
  async send(params: { to: string; subject: string; html: string }): Promise<void> {
    const settings = await getSystemSettings(getPool());
    if (!settings?.smtpHost) {
      throw new InternalServerErrorException(
        'SMTP no está configurado — no se puede enviar el correo (configúralo en /settings)',
      );
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
}
