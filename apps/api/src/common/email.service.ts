import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';

@Injectable()
export class EmailService {
  private transporter: Transporter | null = null;

  async send(params: { to: string; subject: string; html: string }): Promise<void> {
    const transporter = this.getTransporter();
    await transporter.sendMail({
      from: process.env.SMTP_FROM ?? 'DevSentinel AI <no-reply@devsentinel.local>',
      to: params.to,
      subject: params.subject,
      html: params.html,
    });
  }

  private getTransporter(): Transporter {
    if (this.transporter) return this.transporter;

    const host = process.env.SMTP_HOST;
    if (!host) {
      throw new InternalServerErrorException(
        'SMTP no está configurado (falta SMTP_HOST) — no se puede enviar el correo',
      );
    }

    this.transporter = createTransport({
      host,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: Number(process.env.SMTP_PORT ?? 587) === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
    });
    return this.transporter;
  }
}
