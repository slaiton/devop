import { Body, Controller, Get, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { getPool } from '@devsentinel/database';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from '../../common/jwtAuth.guard';
import { CurrentOrg } from '../../common/currentOrg.decorator';
import { CurrentUser } from '../../common/currentUser.decorator';

// Secure cookies exigen HTTPS; en local (PUBLIC_WEB_ORIGIN=http://localhost) el
// navegador las descarta en silencio si quedan marcadas secure sobre HTTP plano.
const COOKIES_REQUIRE_HTTPS = (process.env.PUBLIC_WEB_ORIGIN ?? '').startsWith('https://');

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  async login(@Body() body: { email: string; password: string }, @Res() res: Response): Promise<void> {
    const { userId } = await this.authService.login(body.email ?? '', body.password ?? '');
    const organizationId = await this.authService.findOrganizationForUser(userId);
    if (!organizationId) {
      res.status(403).json({ message: 'tu usuario no tiene una organización asignada — contacta a un administrador' });
      return;
    }

    const token = this.authService.issueSessionToken(userId, organizationId);
    res.cookie('session', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: COOKIES_REQUIRE_HTTPS,
      maxAge: 4 * 60 * 60 * 1000, // igual al expiresIn del JWT (issueSessionToken)
    });
    res.json({ ok: true });
  }

  @Get('logout')
  logout(@Res() res: Response): void {
    res.clearCookie('session');
    res.redirect(process.env.PUBLIC_WEB_ORIGIN ?? '/');
  }

  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  async changePassword(
    @CurrentUser() userId: string,
    @Body() body: { currentPassword: string; newPassword: string },
  ): Promise<{ ok: true }> {
    await this.authService.changePassword(userId, body.currentPassword ?? '', body.newPassword ?? '');
    return { ok: true };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentOrg() orgId: string, @CurrentUser() userId: string) {
    const role = await this.authService.getMembershipRole(orgId, userId);
    const [{ rows: userRows }, { rows: orgRows }] = await Promise.all([
      getPool().query('SELECT name, avatar_url, email FROM users WHERE id = $1', [userId]),
      getPool().query('SELECT name FROM organizations WHERE id = $1', [orgId]),
    ]);
    const user = userRows[0];
    return {
      userId,
      orgId,
      role,
      name: user?.name ?? null,
      avatarUrl: user?.avatar_url ?? null,
      email: user?.email ?? null,
      orgName: orgRows[0]?.name ?? null,
    };
  }
}
