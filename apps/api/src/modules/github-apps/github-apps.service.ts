import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { sign, verify } from 'jsonwebtoken';
import type { PoolClient } from 'pg';
import { withTenant } from '@devsentinel/database';
import { GithubAdapter, type WebhookDeliverySummary } from '@devsentinel/git-providers';
import { loadGithubAppCredentials, upsertInstallationRepositories } from '@devsentinel/github-apps';
import { encrypt } from '@devsentinel/settings';

/** Eventos que DevSentinel necesita que la App tenga suscritos (`installation` e
 * `installation_repositories` GitHub los manda siempre, no hace falta suscribirlos). */
const REQUIRED_WEBHOOK_EVENTS = ['push', 'pull_request', 'issues', 'issue_comment'];

export interface WebhookCheck {
  key: string;
  ok: boolean;
  message: string;
}

export interface WebhookDiagnosticsReport {
  expectedUrl: string;
  reachable: boolean;
  checks: WebhookCheck[];
  webhookUrl: string | null;
  subscribedEvents: string[];
  recentDeliveries: WebhookDeliverySummary[];
}

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

  /** Por qué una App no está mandando (o no se le están aceptando) los pushes: consulta
   * a GitHub, con las credenciales de la propia App, su configuración de webhook y sus
   * últimas entregas, y la cruza con lo que DevSentinel espera. Nada de esto se ve desde
   * la base de datos — un secret mal copiado solo se manifiesta como 401 del lado de GitHub. */
  async getWebhookDiagnostics(orgId: string, githubAppRowId: string): Promise<WebhookDiagnosticsReport> {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query('SELECT github_app_id FROM github_apps WHERE id = $1 AND organization_id = $2', [
        githubAppRowId,
        orgId,
      ]);
      if (!rows[0]) throw new NotFoundException('GitHub App no encontrada');
      const storedAppId = String(rows[0].github_app_id);
      const expectedUrl = this.expectedWebhookUrl();

      let diag;
      try {
        diag = await (await buildAdapterForApp(client, githubAppRowId)).getWebhookDiagnostics();
      } catch (err) {
        return {
          expectedUrl,
          reachable: false,
          checks: [
            {
              key: 'credentials',
              ok: false,
              message: `No se pudo consultar GitHub con las credenciales guardadas para esta App (${(err as Error).message}). Revisá App ID y private key.`,
            },
          ],
          webhookUrl: null,
          subscribedEvents: [],
          recentDeliveries: [],
        };
      }

      const checks: WebhookCheck[] = [];
      checks.push({
        key: 'app_id',
        ok: String(diag.appId) === storedAppId,
        message:
          String(diag.appId) === storedAppId
            ? `App ID correcto (${storedAppId}).`
            : `El App ID guardado (${storedAppId}) no coincide con el real de la App (${diag.appId}). Los webhooks llegan con el real y se rechazan.`,
      });

      const normalize = (u: string | null) => (u ?? '').replace(/\/+$/, '');
      const urlOk = Boolean(expectedUrl) && normalize(diag.webhookUrl) === normalize(expectedUrl);
      checks.push({
        key: 'webhook_url',
        ok: urlOk,
        message: urlOk
          ? 'La URL del webhook apunta a este despliegue.'
          : `La URL del webhook en GitHub es ${diag.webhookUrl ?? '(vacía)'} y debería ser ${expectedUrl || '(PUBLIC_WEB_ORIGIN no está definido en el servidor)'}.`,
      });

      const missing = REQUIRED_WEBHOOK_EVENTS.filter((e) => !diag.subscribedEvents.includes(e));
      checks.push({
        key: 'events',
        ok: missing.length === 0,
        message:
          missing.length === 0
            ? `Suscrita a los eventos necesarios (${REQUIRED_WEBHOOK_EVENTS.join(', ')}).`
            : `Falta suscribir la App a: ${missing.join(', ')}. Se cambia en github.com → Settings → Developer settings → tu App → Permissions & events (para "push" la App necesita el permiso Contents: Read).`,
      });

      const failed = diag.recentDeliveries.filter((d) => d.statusCode >= 400 || d.statusCode === 0);
      const statusSummary = [...new Set(failed.map((d) => d.statusCode))].join(', ');
      checks.push({
        key: 'deliveries',
        ok: failed.length === 0,
        message:
          failed.length === 0
            ? diag.recentDeliveries.length
              ? `Las últimas ${diag.recentDeliveries.length} entregas fueron aceptadas.`
              : 'GitHub todavía no registró ninguna entrega para esta App.'
            : `${failed.length} de las últimas ${diag.recentDeliveries.length} entregas fallaron (HTTP ${statusSummary}). ${
                failed.some((d) => d.statusCode === 401)
                  ? '401 = el webhook secret de GitHub no coincide con el guardado acá, o el App ID está mal.'
                  : 'Revisá que la URL del webhook sea accesible desde internet.'
              }`,
      });

      const pushDeliveries = diag.recentDeliveries.filter((d) => d.event === 'push');
      checks.push({
        key: 'push_deliveries',
        ok: pushDeliveries.length > 0,
        message: pushDeliveries.length
          ? `GitHub intentó entregar ${pushDeliveries.length} push(es) recientemente.`
          : 'GitHub no registra ningún push enviado por esta App: o no hubo pushes en repos donde está instalada, o el evento push no está suscrito, o el webhook está desactivado.',
      });

      return {
        expectedUrl,
        reachable: true,
        checks,
        webhookUrl: diag.webhookUrl,
        subscribedEvents: diag.subscribedEvents,
        recentDeliveries: diag.recentDeliveries.slice(0, 15),
      };
    });
  }

  /** Alinea el webhook de la App en GitHub con este despliegue (URL + el secret que
   * DevSentinel tiene guardado, que es con el que verifica cada firma). */
  async repairWebhook(orgId: string, githubAppRowId: string): Promise<{ url: string }> {
    const url = this.expectedWebhookUrl();
    if (!url) throw new BadRequestException('PUBLIC_WEB_ORIGIN no está definido en el servidor, no se puede calcular la URL del webhook');
    await withTenant(orgId, async (client) => {
      const { rows } = await client.query('SELECT id FROM github_apps WHERE id = $1 AND organization_id = $2', [
        githubAppRowId,
        orgId,
      ]);
      if (!rows[0]) throw new NotFoundException('GitHub App no encontrada');
      try {
        await (await buildAdapterForApp(client, githubAppRowId)).updateWebhookConfig(url);
      } catch (err) {
        throw new BadGatewayException(`GitHub rechazó actualizar el webhook de esta App: ${(err as Error).message}`);
      }
    });
    return { url };
  }

  /** Reenvía las entregas que GitHub intentó y DevSentinel rechazó — recupera los pushes
   * que se perdieron mientras el webhook estaba mal configurado. */
  async redeliverFailedWebhooks(orgId: string, githubAppRowId: string): Promise<{ redelivered: number }> {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query('SELECT id FROM github_apps WHERE id = $1 AND organization_id = $2', [
        githubAppRowId,
        orgId,
      ]);
      if (!rows[0]) throw new NotFoundException('GitHub App no encontrada');
      try {
        const redelivered = await (await buildAdapterForApp(client, githubAppRowId)).redeliverFailedWebhooks();
        return { redelivered };
      } catch (err) {
        throw new BadGatewayException(`GitHub rechazó reenviar las entregas fallidas: ${(err as Error).message}`);
      }
    });
  }

  private expectedWebhookUrl(): string {
    const origin = (process.env.PUBLIC_WEB_ORIGIN ?? '').replace(/\/+$/, '');
    return origin ? `${origin}/api/webhooks/github` : '';
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
