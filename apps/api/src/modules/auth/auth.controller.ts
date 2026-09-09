import { BadRequestException, Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { getPool } from '@devsentinel/database';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from '../../common/jwtAuth.guard';
import { CurrentOrg } from '../../common/currentOrg.decorator';
import { CurrentUser } from '../../common/currentUser.decorator';

// Secure cookies exigen HTTPS; en local (PUBLIC_WEB_ORIGIN=http://localhost) el
// navegador las descarta en silencio si quedan marcadas secure sobre HTTP plano.
const COOKIES_REQUIRE_HTTPS = (process.env.PUBLIC_WEB_ORIGIN ?? '').startsWith('https://');

@Controller('auth/github')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('login')
  login(@Res() res: Response): void {
    const state = randomBytes(16).toString('hex');
    res.cookie('oauth_state', state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: COOKIES_REQUIRE_HTTPS,
      maxAge: 5 * 60 * 1000,
    });
    res.redirect(this.authService.buildAuthorizeUrl(state));
  }

  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string | undefined,
    @Query('setup_action') setupAction: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // GitHub omite `state` cuando el callback llega desde la pantalla de
    // instalación/actualización de la App (setup_action=install|update) en vez
    // del /login/oauth/authorize que nosotros iniciamos; ahí no hay CSRF que
    // validar porque el `code` de un solo uso ya ata la respuesta a nuestro
    // client_secret.
    const isInstallSetup = setupAction === 'install' || setupAction === 'update';
    if (!code || (!isInstallSetup && (!state || state !== req.cookies?.oauth_state))) {
      throw new BadRequestException('invalid OAuth state');
    }
    res.clearCookie('oauth_state');

    let githubUser;
    try {
      githubUser = await this.authService.exchangeCodeForUser(code);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    const userId = await this.authService.upsertUser(githubUser);

    // Camino 1: es quien instaló la GitHub App (su login coincide con el slug de la
    // org) → admin. Camino 2: ya es miembro por invitación previa, aunque su login no
    // coincida con ningún slug. Si ninguno aplica, no tiene organización todavía.
    let organizationId = await this.authService.findOrganizationForLogin(githubUser.login);
    if (organizationId) {
      await this.authService.ensureMembership(organizationId, userId);
    } else {
      organizationId = await this.authService.findOrganizationForUser(userId);
    }

    if (!organizationId) {
      const appSlug = process.env.GITHUB_APP_SLUG ?? '';
      res.redirect(`https://github.com/apps/${appSlug}/installations/new`);
      return;
    }

    await this.authService.linkDeveloperRecords(organizationId, userId, githubUser.login, githubUser.email);
    const token = this.authService.issueSessionToken(userId, organizationId);

    res.cookie('session', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: COOKIES_REQUIRE_HTTPS,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.redirect(process.env.PUBLIC_WEB_ORIGIN ?? '/');
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentOrg() orgId: string, @CurrentUser() userId: string) {
    const role = await this.authService.getMembershipRole(orgId, userId);
    const { rows } = await getPool().query(
      'SELECT name, avatar_url, email, github_user_id FROM users WHERE id = $1',
      [userId],
    );
    const user = rows[0];
    return {
      userId,
      orgId,
      role,
      name: user?.name ?? null,
      avatarUrl: user?.avatar_url ?? null,
      email: user?.email ?? null,
    };
  }
}
