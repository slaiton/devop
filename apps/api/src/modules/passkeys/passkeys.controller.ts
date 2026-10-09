import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { JwtAuthGuard, type RequestWithSession } from '../../common/jwtAuth.guard';
import { RecentAuthGuard } from '../../common/recentAuth.guard';
import { CurrentOrg } from '../../common/currentOrg.decorator';
import { CurrentUser } from '../../common/currentUser.decorator';
import { COOKIES_REQUIRE_HTTPS, clientInfo, setSessionCookie } from '../../common/session';
import { AuthService } from '../auth/auth.service';
import { PasskeysService } from './passkeys.service';

const CHALLENGE_COOKIE = 'pk_chal';
const CHALLENGE_COOKIE_PATH = '/api/auth';

/** El challenge viaja en una cookie httpOnly SameSite=Strict (no en el JSON): ata la
 * verificación al mismo navegador que pidió las opciones, y evita que una aserción ajena
 * pueda "loguear" a la víctima en la cuenta del atacante (login CSRF). */
function setChallengeCookie(res: Response, challengeId: string): void {
  res.cookie(CHALLENGE_COOKIE, challengeId, {
    httpOnly: true,
    sameSite: 'strict',
    secure: COOKIES_REQUIRE_HTTPS,
    path: CHALLENGE_COOKIE_PATH,
    maxAge: 5 * 60 * 1000,
  });
}

function takeChallengeCookie(req: Request, res: Response): string | undefined {
  const id = req.cookies?.[CHALLENGE_COOKIE] as string | undefined;
  res.clearCookie(CHALLENGE_COOKIE, { path: CHALLENGE_COOKIE_PATH });
  return id;
}

@Controller('auth')
export class PasskeysController {
  constructor(
    private readonly passkeys: PasskeysService,
    private readonly auth: AuthService,
  ) {}

  // ---------- gestión (sesión iniciada) ----------

  @Get('passkeys')
  @UseGuards(JwtAuthGuard)
  list(@CurrentUser() userId: string) {
    return this.passkeys.list(userId);
  }

  @Post('passkeys/register/options')
  @UseGuards(JwtAuthGuard, RecentAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async registerOptions(@CurrentUser() userId: string, @Res({ passthrough: true }) res: Response) {
    const { options, challengeId } = await this.passkeys.startRegistration(userId);
    setChallengeCookie(res, challengeId);
    return { options };
  }

  @Post('passkeys/register/verify')
  @UseGuards(JwtAuthGuard, RecentAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async registerVerify(
    @CurrentUser() userId: string,
    @Body() body: { response: RegistrationResponseJSON; name?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const passkey = await this.passkeys.finishRegistration(userId, takeChallengeCookie(req, res), body.response, body.name, clientInfo(req));
    return { passkey };
  }

  @Patch('passkeys/:id')
  @UseGuards(JwtAuthGuard)
  rename(@CurrentUser() userId: string, @Param('id') id: string, @Body() body: { name: string }) {
    return this.passkeys.rename(userId, id, body.name);
  }

  @Delete('passkeys/:id')
  @UseGuards(JwtAuthGuard, RecentAuthGuard)
  async remove(
    @CurrentUser() userId: string,
    @CurrentOrg() orgId: string,
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { sessionVersion, credentialId } = await this.passkeys.remove(userId, id, clientInfo(req));
    // La versión de sesión subió: esta sesión recibe un token nuevo para no cerrarse a sí misma.
    const amr = (req as RequestWithSession).session?.amr ?? 'pwd';
    setSessionCookie(res, this.auth.issueSessionToken(userId, orgId, { amr, sessionVersion }));
    return { ok: true, credentialId };
  }

  // ---------- reautenticación con passkey ----------

  @Post('passkey/reauth/options')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async reauthOptions(@CurrentUser() userId: string, @Res({ passthrough: true }) res: Response) {
    const { options, challengeId } = await this.passkeys.startAuthentication('reauth', userId);
    setChallengeCookie(res, challengeId);
    return { options };
  }

  @Post('passkey/reauth/verify')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async reauthVerify(
    @CurrentUser() userId: string,
    @CurrentOrg() orgId: string,
    @Body() body: { response: AuthenticationResponseJSON },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.passkeys.finishAuthentication(takeChallengeCookie(req, res), body.response, 'reauth', userId, clientInfo(req));
    const state = await this.auth.getSessionState(userId);
    setSessionCookie(res, this.auth.issueSessionToken(userId, orgId, { amr: 'webauthn', sessionVersion: state!.sessionVersion }));
    return { ok: true };
  }

  // ---------- login con passkey (público) ----------

  // Públicos a propósito: es el inicio de sesión. Sin correo previo (passkey descubrible).
  @Post('passkey/options')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async loginOptions(@Res({ passthrough: true }) res: Response) {
    const { options, challengeId } = await this.passkeys.startAuthentication('login');
    setChallengeCookie(res, challengeId);
    return { options };
  }

  @Post('passkey/verify')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async loginVerify(
    @Body() body: { response: AuthenticationResponseJSON },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { userId } = await this.passkeys.finishAuthentication(takeChallengeCookie(req, res), body.response, 'login', undefined, clientInfo(req));
    const orgId = await this.auth.findOrganizationForUser(userId);
    if (!orgId) {
      throw new ForbiddenException('tu usuario no tiene una organización asignada — contacta a un administrador');
    }
    const state = await this.auth.getSessionState(userId);
    setSessionCookie(res, this.auth.issueSessionToken(userId, orgId, { amr: 'webauthn', sessionVersion: state!.sessionVersion }));
    return { ok: true };
  }
}
