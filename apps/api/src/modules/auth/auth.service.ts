import { ForbiddenException, Injectable } from '@nestjs/common';
import { sign } from 'jsonwebtoken';
import { getPool, withTenant } from '@devsentinel/database';
import { getSystemSettings } from '@devsentinel/settings';
import { GithubAdapter } from '@devsentinel/git-providers';

interface GithubTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

export interface GithubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
}

@Injectable()
export class AuthService {
  async buildAuthorizeUrl(state: string): Promise<string> {
    const settings = await getSystemSettings(getPool());
    const params = new URLSearchParams({
      client_id: settings?.githubAppClientId ?? '',
      redirect_uri: process.env.GITHUB_OAUTH_CALLBACK_URL ?? '',
      state,
    });
    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  /** Genera la URL para instalar la App en otra cuenta de GitHub, ligando esa
   * instalación a `organizationId` cuando el callback la reciba de vuelta. */
  async buildLinkAccountUrl(organizationId: string): Promise<string> {
    const settings = await getSystemSettings(getPool());
    const slug = settings?.githubAppSlug ?? '';
    const state = sign({ purpose: 'link-installation', orgId: organizationId }, process.env.JWT_SECRET ?? '', {
      expiresIn: '10m',
    });
    return `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`;
  }

  /** Re-parenta una instalación (y sus repos ya sincronizados) a la organización
   * indicada — usado por el callback cuando `state` es un token de link válido. */
  async linkInstallation(organizationId: string, installationId: number): Promise<void> {
    const settings = await getSystemSettings(getPool());
    const adapter = new GithubAdapter({
      appId: settings?.githubAppId ?? '',
      privateKey: (settings?.githubAppPrivateKey ?? '').replace(/\\n/g, '\n'),
      webhookSecret: settings?.githubAppWebhookSecret ?? '',
    });
    const accountLogin = await adapter.getInstallationAccountLogin(installationId);
    await getPool().query('SELECT link_installation_to_organization($1, $2, $3)', [
      installationId,
      organizationId,
      accountLogin,
    ]);
  }

  async exchangeCodeForUser(code: string): Promise<GithubUser> {
    const settings = await getSystemSettings(getPool());
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: settings?.githubAppClientId,
        client_secret: settings?.githubAppClientSecret,
        code,
      }),
    });
    const tokenData = (await tokenResponse.json()) as GithubTokenResponse;
    if (!tokenData.access_token) {
      throw new Error(`GitHub OAuth exchange failed: ${tokenData.error_description ?? tokenData.error ?? 'unknown error'}`);
    }

    const userResponse = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'User-Agent': 'devsentinel-ai',
      },
    });
    return (await userResponse.json()) as GithubUser;
  }

  /** El login ya no da de alta usuarios a ciegas: si `github_user_id` ya existe
   * (alguien que ya se logueó antes), solo refresca su perfil. Si es la primera vez,
   * exige que su correo de GitHub coincida con un usuario pendiente (`github_user_id
   * IS NULL`) pre-registrado por un admin desde /users — si no hay match, se rechaza. */
  async resolveRegisteredUser(githubUser: GithubUser): Promise<string> {
    const pool = getPool();
    const { rows: byGithubId } = await pool.query('SELECT id FROM users WHERE github_user_id = $1', [githubUser.id]);
    if (byGithubId[0]) {
      const userId = byGithubId[0].id as string;
      await pool.query(
        `UPDATE users SET name = COALESCE($2, name), avatar_url = $3, email = COALESCE($4, email) WHERE id = $1`,
        [userId, githubUser.name, githubUser.avatar_url, githubUser.email],
      );
      return userId;
    }

    if (!githubUser.email) {
      throw new ForbiddenException(
        'tu cuenta de GitHub no expone un correo público — pídele a un administrador que verifique tu registro',
      );
    }

    const { rows: pending } = await pool.query(
      'SELECT id FROM users WHERE github_user_id IS NULL AND lower(email) = lower($1)',
      [githubUser.email],
    );
    if (!pending[0]) {
      throw new ForbiddenException('tu correo no está registrado — pídele a un administrador que te agregue desde Usuarios');
    }

    const userId = pending[0].id as string;
    await pool.query(`UPDATE users SET github_user_id = $2, name = COALESCE(name, $3), avatar_url = $4 WHERE id = $1`, [
      userId,
      githubUser.id,
      githubUser.name,
      githubUser.avatar_url,
    ]);
    return userId;
  }

  /** org_memberships tiene RLS, así que resolver el tenant de un usuario sin conocerlo
   * aún exige la función SECURITY DEFINER creada en la migración 0012 (mismo patrón
   * que resolve_organization_for_installation). */
  async findOrganizationForUser(userId: string): Promise<string | null> {
    const { rows } = await getPool().query('SELECT resolve_organization_for_user($1) AS organization_id', [userId]);
    return rows[0]?.organization_id ?? null;
  }

  /** Bootstrap para organizaciones nuevas (una cuenta de GitHub distinta instala la
   * App después de la primera, vía `setup_action=install`): si esa instalación resuelve
   * a una organización que todavía tiene CERO miembros, quien completa el login se
   * vuelve admin. Si la organización ya tiene gente, no otorga nada — evita reabrir la
   * puerta de auto-admin en organizaciones ya pobladas. */
  async bootstrapFirstAdminForInstallation(installationId: number, userId: string): Promise<string | null> {
    const { rows } = await getPool().query('SELECT resolve_organization_for_installation($1) AS organization_id', [
      installationId,
    ]);
    const organizationId: string | null = rows[0]?.organization_id ?? null;
    if (!organizationId) return null;

    return withTenant(organizationId, async (client) => {
      const { rows: memberRows } = await client.query(
        'SELECT count(*)::int AS n FROM org_memberships WHERE organization_id = $1',
        [organizationId],
      );
      if (memberRows[0].n > 0) return null;
      await client.query(`INSERT INTO org_memberships (organization_id, user_id, role) VALUES ($1, $2, 'admin')`, [
        organizationId,
        userId,
      ]);
      return organizationId;
    });
  }

  /** Enlaza retroactivamente contribuciones (developers) resueltas por login/email de
   * commit con la cuenta que acaba de loguearse, para que su vista personal las vea. */
  async linkDeveloperRecords(organizationId: string, userId: string, githubLogin: string, email: string | null): Promise<void> {
    await withTenant(organizationId, async (client) => {
      await client.query(
        `UPDATE developers SET user_id = $1
         WHERE organization_id = $2 AND user_id IS NULL
           AND ((github_login IS NOT NULL AND github_login = $3) OR ($4::text IS NOT NULL AND email = $4))`,
        [userId, organizationId, githubLogin, email],
      );
    });
  }

  async getMembershipRole(organizationId: string, userId: string): Promise<string | null> {
    return withTenant(organizationId, async (client) => {
      const { rows } = await client.query(
        'SELECT role FROM org_memberships WHERE organization_id = $1 AND user_id = $2',
        [organizationId, userId],
      );
      return rows[0]?.role ?? null;
    });
  }

  issueSessionToken(userId: string, organizationId: string): string {
    return sign({ sub: userId, orgId: organizationId }, process.env.JWT_SECRET ?? '', { expiresIn: '7d' });
  }
}
