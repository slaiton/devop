import { Injectable } from '@nestjs/common';
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

  async getAppSlug(): Promise<string> {
    const settings = await getSystemSettings(getPool());
    return settings?.githubAppSlug ?? '';
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

  async upsertUser(githubUser: GithubUser): Promise<string> {
    const { rows } = await getPool().query(
      `INSERT INTO users (github_user_id, email, name, avatar_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (github_user_id) DO UPDATE SET email = $2, name = $3, avatar_url = $4
       RETURNING id`,
      [githubUser.id, githubUser.email, githubUser.name, githubUser.avatar_url],
    );
    return rows[0].id as string;
  }

  async findOrganizationForLogin(login: string): Promise<string | null> {
    const { rows } = await getPool().query('SELECT id FROM organizations WHERE slug = $1', [login.toLowerCase()]);
    return rows[0]?.id ?? null;
  }

  /** Cubre el caso de alguien invitado cuyo login de GitHub no coincide con el slug de
   * la organización (ese matching solo aplica a quien instaló la App). org_memberships
   * tiene RLS, así que resolver el tenant sin conocerlo aún exige la función
   * SECURITY DEFINER creada en la migración 0012 (mismo patrón que
   * resolve_organization_for_installation). */
  async findOrganizationForUser(userId: string): Promise<string | null> {
    const { rows } = await getPool().query('SELECT resolve_organization_for_user($1) AS organization_id', [userId]);
    return rows[0]?.organization_id ?? null;
  }

  async ensureMembership(organizationId: string, userId: string): Promise<void> {
    await withTenant(organizationId, async (client) => {
      await client.query(
        `INSERT INTO org_memberships (organization_id, user_id, role)
         VALUES ($1, $2, 'admin')
         ON CONFLICT (organization_id, user_id) DO NOTHING`,
        [organizationId, userId],
      );
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

  /** Invita a alguien por username de GitHub (API pública, sin auth) con rol "usuario"
   * (developer) — no requiere que esa persona haya iniciado sesión todavía. */
  async inviteUser(organizationId: string, githubLogin: string): Promise<{ userId: string }> {
    const res = await fetch(`https://api.github.com/users/${encodeURIComponent(githubLogin)}`, {
      headers: { 'User-Agent': 'devsentinel-ai', Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
      throw new Error(`no se encontró la cuenta de GitHub "${githubLogin}"`);
    }
    const ghUser = (await res.json()) as { id: number; login: string; name: string | null; avatar_url: string };

    const { rows } = await getPool().query(
      `INSERT INTO users (github_user_id, email, name, avatar_url)
       VALUES ($1, NULL, $2, $3)
       ON CONFLICT (github_user_id) DO UPDATE SET name = COALESCE(users.name, $2), avatar_url = $3
       RETURNING id`,
      [ghUser.id, ghUser.name ?? ghUser.login, ghUser.avatar_url],
    );
    const userId = rows[0].id as string;

    await withTenant(organizationId, async (client) => {
      await client.query(
        `INSERT INTO org_memberships (organization_id, user_id, role)
         VALUES ($1, $2, 'developer')
         ON CONFLICT (organization_id, user_id) DO NOTHING`,
        [organizationId, userId],
      );
    });

    return { userId };
  }

  issueSessionToken(userId: string, organizationId: string): string {
    return sign({ sub: userId, orgId: organizationId }, process.env.JWT_SECRET ?? '', { expiresIn: '7d' });
  }
}
