import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../common/jwtAuth.guard';
import { CurrentUser } from '../../common/currentUser.decorator';
import { clientInfo } from '../../common/session';
import { AccountService } from './account.service';

@Controller('auth')
export class AccountController {
  constructor(private readonly accountService: AccountService) {}

  // Públicos a propósito: se llega desde un enlace de correo, sin sesión. La autorización
  // real es el token de un solo uso.
  @Post('verify-email')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async verifyEmail(@Body() body: { token: string }, @Req() req: Request): Promise<{ ok: true }> {
    await this.accountService.verifyEmail(body.token ?? '', clientInfo(req));
    return { ok: true };
  }

  @Post('recover/request')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async requestRecovery(@Body() body: { email: string }, @Req() req: Request): Promise<{ ok: true }> {
    await this.accountService.requestPasswordReset(body.email ?? '', clientInfo(req));
    return { ok: true }; // misma respuesta exista o no el correo
  }

  @Post('recover/complete')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async completeRecovery(@Body() body: { token: string; newPassword: string }, @Req() req: Request): Promise<{ ok: true }> {
    await this.accountService.completePasswordReset(body.token ?? '', body.newPassword ?? '', clientInfo(req));
    return { ok: true };
  }

  @Post('resend-verification')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async resendVerification(@CurrentUser() userId: string): Promise<{ sent: boolean }> {
    return { sent: await this.accountService.sendVerificationEmail(userId) };
  }
}
