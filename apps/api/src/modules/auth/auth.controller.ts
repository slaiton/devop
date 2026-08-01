import { BadRequestException, Controller, Get, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { AuthService } from './auth.service';

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

    const githubUser = await this.authService.exchangeCodeForUser(code);
    const userId = await this.authService.upsertUser(githubUser);

    const organizationId = await this.authService.findOrganizationForLogin(githubUser.login);
    if (!organizationId) {
      const appSlug = process.env.GITHUB_APP_SLUG ?? '';
      res.redirect(`https://github.com/apps/${appSlug}/installations/new`);
      return;
    }

    await this.authService.ensureMembership(organizationId, userId);
    const token = this.authService.issueSessionToken(userId, organizationId);

    res.cookie('session', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: COOKIES_REQUIRE_HTTPS,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.redirect(process.env.PUBLIC_WEB_ORIGIN ?? '/');
  }
}
