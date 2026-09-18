import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { getPool } from '@devsentinel/database';
import { sendEmail, SmtpNotConfiguredError } from '@devsentinel/settings';

@Injectable()
export class EmailService {
  async send(params: { to: string; subject: string; html: string }): Promise<void> {
    try {
      await sendEmail(getPool(), params);
    } catch (err) {
      if (err instanceof SmtpNotConfiguredError) {
        throw new InternalServerErrorException(err.message);
      }
      throw err;
    }
  }
}
