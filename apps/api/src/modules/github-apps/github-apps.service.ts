import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { sign, verify } from 'jsonwebtoken';
import type { PoolClient } from 'pg';
import { withTenant } from '@devsentinel/database';
import { GithubAdapter } from '@devsentinel/git-providers';
import { loadGithubAppCredentials, upsertInstallationRepositories } from '@devsentinel/github-apps';
import { encrypt } from '@devsentinel/settings';

async function buildAdapterForApp(client: PoolClient, githubAppRowId: string): Promise<GithubAdapter> {
  const creds = await loadGithubAppCredentials(client, githubAppRowId);
  return new GithubAdapter({ appId: creds.appId, privateKey: creds.privateKey, webhookSecret: creds.webhookSecret });
}

export interface CreateGithubAppInput {
  name: string;
  githubAppId: string;
  slug: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  webhookSecret: string;
}

interface ConnectStatePayload {
  purpose: 'connect-app';
  orgId: string;
  githubAppRowId: string;
}

const REQUIRED_FIELDS: (keyof CreateGithubAppInput)[] = [
  'name',
  'githubAppId',
  'slug',
  'clientId',
  'clientSecret',
  'privateKey',
  'webhookSecret',
];

@Injectable()
export class GithubAppsService {
  async list(orgId: string) {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT ga.id, ga.name, ga.github_app_id, ga.slug, ga.client_id, ga.created_at,
                COUNT(gi.id)::int AS installation_count
         FROM github_apps ga
         LEFT JOIN github_installations gi ON gi.github_app_id = ga.id AND gi.status = 'active'
         WHERE ga.organization_id = $1
         GROUP BY ga.id
         ORDER BY ga.created_at`,
        [orgId],
      );
      return rows;
    });
  }

  async listInstallations(orgId: string, githubAppRowId: string) {
    return withTenant(orgId, async (client) => {
      const { rows: appRows } = await client.query('SELECT id FROM github_apps WHERE id = $1 AND organization_id = $2', [
        githubAppRowId,
        orgId,
      ]);
      if (!appRows[0]) throw new NotFoundException('GitHub App no encontrada');

      const { rows } = await client.query(
        `SELECT gi.id, gi.installation_id, gi.account_login, gi.status, gi.created_at, gi.repos_synced_at,
                (SELECT count(*)::int FROM repositories r WHERE r.github_installation_id = gi.id) AS repository_count
         FROM github_installations gi
         WHERE gi.organization_id = $1 AND gi.github_app_id = $2
         ORDER BY gi.created_at DESC`,
        [orgId, githubAppRowId],
      );
      return rows;
    });
  }

  /** Trae los repos accesibles para esta instalación directamente de la API de GitHub
   * (no depende de que el webhook `installation_repositories` haya llegado) — se usa
   * automáticamente al conectar una cuenta nueva y como botón manual "sincronizar
   * ahora" para instalaciones ya conectadas cuyo webhook nunca llegó a configurarse. */
  async syncRepositories(orgId: string, installationRowId: string): Promise<{ repository_count: number }> {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT gi.id, gi.installation_id, ga.id AS github_app_row_id
         FROM github_installations gi
         JOIN github_apps ga ON ga.id = gi.github_app_id
         WHERE gi.id = $1 AND gi.organization_id = $2`,
        [installationRowId, orgId],
      );
      const row = rows[0];
      if (!row) throw new NotFoundException('instalación no encontrada');

      const adapter = await buildAdapterForApp(client, row.github_app_row_id);
      const repos = await adapter.listInstallationRepositories(Number(row.installation_id));
      await upsertInstallationRepositories(client, orgId, installationRowId, repos);

      return { repository_count: repos.length };
    });
  }

  /** Reconcilia TODAS las instalaciones reales de esta App (vía la API de GitHub, no
   * vía el flujo interactivo de "instalar") y sincroniza sus repos — el respaldo para
   * cuentas que ya tenían la App instalada de antes de conectarla acá (p. ej. la cuenta
   * principal, instalada bajo el viejo sistema de un solo App global vía `.env`):
   * GitHub no pasa por nuestro callback cuando la App ya está instalada en la cuenta
   * elegida, así que "Conectar" nunca llega a dispararse para esos casos. */
  async syncInstallations(orgId: string, githubAppRowId: string): Promise<{ installations: number; repositories: number }> {
    return withTenant(orgId, async (client) => {
      const { rows: appRows } = await client.query('SELECT id FROM github_apps WHERE id = $1 AND organization_id = $2', [
        githubAppRowId,
        orgId,
      ]);
      if (!appRows[0]) throw new NotFoundException('GitHub App no encontrada');

      const adapter = await buildAdapterForApp(client, githubAppRowId);
      const installations = await adapter.listAppInstallations();

      let totalRepos = 0;
      for (const installation of installations) {
        await client.query('SELECT link_installation_to_organization($1, $2, $3, $4)', [
          installation.installationId,
          orgId,
          installation.accountLogin,
          githubAppRowId,
        ]);
        const { rows } = await client.query('SELECT id FROM github_installations WHERE installation_id = $1', [
          installation.installationId,
        ]);
        const installationRowId: string | undefined = rows[0]?.id;
        if (!installationRowId) continue;
        const repos = await adapter.listInstallationRepositories(installation.installationId);
        await upsertInstallationRepositories(client, orgId, installationRowId, repos);
        totalRepos += repos.length;
      }

      return { installations: installations.length, repositories: totalRepos };
    });
  }

  async create(orgId: string, input: CreateGithubAppInput) {
    for (const field of REQUIRED_FIELDS) {
      if (!input[field]?.trim()) {
        throw new BadRequestException('todos los campos de la GitHub App son obligatorios');
      }
    }

    try {
      return await withTenant(orgId, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO github_apps
             (organization_id, name, github_app_id, slug, client_id, client_secret_encrypted, private_key_encrypted, webhook_secret_encrypted)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, name, github_app_id, slug, client_id, created_at`,
          [
            orgId,
            input.name.trim(),
            input.githubAppId.trim(),
            input.slug.trim(),
            input.clientId.trim(),
            encrypt(input.clientSecret.trim()),
            encrypt(input.privateKey.trim()),
            encrypt(input.webhookSecret.trim()),
          ],
        );
        return { ...rows[0], installation_count: 0 };
      });
    } catch (err) {
      if ((err as { code?: string })?.code === '23505') {
        throw new BadRequestException('ya existe una GitHub App registrada con ese App ID');
      }
      throw err;
    }
  }

  async remove(orgId: string, id: string): Promise<void> {
    await withTenant(orgId, async (client) => {
      const { rowCount } = await client.query('DELETE FROM github_apps WHERE organization_id = $1 AND id = $2', [
        orgId,
        id,
      ]);
      if (!rowCount) throw new NotFoundException('GitHub App no encontrada');
    });
  }

  /** Arma la URL de instalación de GitHub para esta App, firmando un `state` de un solo
   * uso (10 min) con el mismo secret que las sesiones (`JWT_SECRET`) — GitHub lo
   * devuelve tal cual en el callback, y es la única forma de saber a qué
   * organización/App atar la instalación resultante sin depender de que el navegador
   * siga logueado en ese momento (mismo patrón que usaba el login por GitHub, ya
   * retirado). */
  async buildConnectUrl(orgId: string, githubAppRowId: string): Promise<string> {
    const slug = await withTenant(orgId, async (client) => {
      const { rows } = await client.query('SELECT slug FROM github_apps WHERE id = $1 AND organization_id = $2', [
        githubAppRowId,
        orgId,
      ]);
      if (!rows[0]) throw new NotFoundException('GitHub App no encontrada');
      return rows[0].slug as string;
    });

    const state = sign({ purpose: 'connect-app', orgId, githubAppRowId } satisfies ConnectStatePayload, process.env.JWT_SECRET ?? '', {
      expiresIn: '10m',
    });
    return `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`;
  }

  /** Callback público (GitHub redirige el navegador acá tras la instalación, sin
   * garantía de que la sesión de DevSentinel siga activa) — la autorización real viene
   * del `state` firmado, no de la sesión. Nunca lanza: siempre devuelve a dónde
   * redirigir, con el resultado codificado en la query string para que `/accounts`
   * muestre un mensaje. */
  async handleInstallCallback(state: string | undefined, installationId: number | undefined): Promise<{ redirectPath: string }> {
    if (!state || !installationId || Number.isNaN(installationId)) {
      return { redirectPath: '/accounts?link_error=missing_params' };
    }

    let payload: ConnectStatePayload;
    try {
      payload = verify(state, process.env.JWT_SECRET ?? '') as ConnectStatePayload;
    } catch {
      return { redirectPath: '/accounts?link_error=invalid_state' };
    }
    if (payload.purpose !== 'connect-app' || !payload.orgId || !payload.githubAppRowId) {
      return { redirectPath: '/accounts?link_error=invalid_state' };
    }

    let adapter: GithubAdapter;
    try {
      adapter = await withTenant(payload.orgId, async (client) => {
        const builtAdapter = await buildAdapterForApp(client, payload.githubAppRowId);
        const accountLogin = await builtAdapter.getInstallationAccountLogin(installationId);
        await client.query('SELECT link_installation_to_organization($1, $2, $3, $4)', [
          installationId,
          payload.orgId,
          accountLogin,
          payload.githubAppRowId,
        ]);
        return builtAdapter;
      });
    } catch {
      return { redirectPath: '/accounts?link_error=link_failed' };
    }

    // La cuenta ya quedó conectada — si la sincronización inicial de repos falla (rate
    // limit, hiccup transitorio de la API), no lo tratamos como un error de conexión;
    // el botón manual "sincronizar ahora" y el webhook siguen siendo el respaldo.
    try {
      await withTenant(payload.orgId, async (client) => {
        const { rows } = await client.query('SELECT id FROM github_installations WHERE installation_id = $1', [
          installationId,
        ]);
        const installationRowId: string | undefined = rows[0]?.id;
        if (!installationRowId) return;
        const repos = await adapter.listInstallationRepositories(installationId);
        await upsertInstallationRepositories(client, payload.orgId, installationRowId, repos);
      });
    } catch {
      return { redirectPath: '/accounts?connected=1&sync_error=1' };
    }

    return { redirectPath: '/accounts?connected=1' };
  }
}
