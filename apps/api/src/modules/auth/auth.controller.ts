import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { getPool } from '@devsentinel/database';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from '../../common/jwtAuth.guard';
import { CurrentOrg } from '../../common/currentOrg.decorator';
import { CurrentUser } from '../../common/currentUser.decorator';
import { AllowPendingPasswordChange } from '../../common/allowPendingPasswordChange.decorator';
import { SESSION_COOKIE, clientInfo, setSessionCookie } from '../../common/session';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async login(@Body() body: { email: string; password: string }, @Req() req: Request, @Res() res: Response): Promise<void> {
    const { userId, sessionVersion, mustChangePassword } = await this.authService.login(
      body.email ?? '',
      body.password ?? '',
      clientInfo(req),
    );
    const organizationId = await this.authService.findOrganizationForUser(userId);
    if (!organizationId) {
      res.status(403).json({ message: 'tu usuario no tiene una organización asignada — contacta a un administrador' });
      return;
    }

    setSessionCookie(res, this.authService.issueSessionToken(userId, organizationId, { amr: 'pwd', sessionVersion, mustChangePassword }));
    res.json({ ok: true, mustChangePassword });
  }

  @Get('logout')
  logout(@Res() res: Response): void {
    res.clearCookie(SESSION_COOKIE);
    res.redirect(process.env.PUBLIC_WEB_ORIGIN ?? '/');
  }

  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  @AllowPendingPasswordChange()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async changePassword(
    @CurrentUser() userId: string,
    @CurrentOrg() orgId: string,
    @Body() body: { currentPassword: string; newPassword: string },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const sessionVersion = await this.authService.changePassword(
      userId,
      body.currentPassword ?? '',
      body.newPassword ?? '',
      clientInfo(req),
    );
    // La versión de sesión subió: esta misma sesión recibe un token nuevo para no quedar
    // cerrada junto con las demás.
    setSessionCookie(res, this.authService.issueSessionToken(userId, orgId, { amr: 'pwd', sessionVersion }));
    res.json({ ok: true });
  }

  /** Reautenticación con contraseña antes de una acción sensible (agregar o borrar una
   * passkey): re-emite la sesión con un `iat` nuevo, que es lo que mira RecentAuthGuard. */
  @Post('reauth')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async reauth(
    @CurrentUser() userId: string,
    @CurrentOrg() orgId: string,
    @Body() body: { password: string },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.authService.verifyPassword(userId, body.password ?? '', clientInfo(req));
    const state = await this.authService.getSessionState(userId);
    setSessionCookie(res, this.authService.issueSessionToken(userId, orgId, { amr: 'pwd', sessionVersion: state!.sessionVersion }));
    res.json({ ok: true });
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @AllowPendingPasswordChange()
  async me(@CurrentOrg() orgId: string, @CurrentUser() userId: string) {
    const role = await this.authService.getMembershipRole(orgId, userId);
    const [{ rows: userRows }, { rows: orgRows }] = await Promise.all([
      getPool().query(
        `SELECT name, avatar_url, email, email_verified_at, must_change_password,
                (SELECT count(*)::int FROM webauthn_credentials c WHERE c.user_id = users.id) AS passkey_count
         FROM users WHERE id = $1`,
        [userId],
      ),
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
      emailVerified: Boolean(user?.email_verified_at),
      mustChangePassword: Boolean(user?.must_change_password),
      passkeyCount: user?.passkey_count ?? 0,
    };
  }
}
