import { Injectable } from '@nestjs/common';
import { sign } from 'jsonwebtoken';
import { getPool, withTenant } from '@devsentinel/database';

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
  buildAuthorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: process.env.GITHUB_APP_CLIENT_ID ?? '',
      redirect_uri: process.env.GITHUB_OAUTH_CALLBACK_URL ?? '',
      state,
    });
    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  async exchangeCodeForUser(code: string): Promise<GithubUser> {
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: process.env.GITHUB_APP_CLIENT_ID,
        client_secret: process.env.GITHUB_APP_CLIENT_SECRET,
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

  issueSessionToken(userId: string, organizationId: string): string {
    return sign({ sub: userId, orgId: organizationId }, process.env.JWT_SECRET ?? '', { expiresIn: '7d' });
  }
}
