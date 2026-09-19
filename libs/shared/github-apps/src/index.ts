import { GithubAdapter } from '@devsentinel/git-providers';
import { decrypt } from '@devsentinel/settings';

/** Subconjunto de `pg.PoolClient`/`Pool` que necesita este helper — evita atar
 * `@devsentinel/github-apps` a una dependencia directa de `pg` solo por el tipo. */
export interface QueryableClient {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface GithubAppCredentials {
  rowId: string;
  appId: string;
  slug: string;
  clientId: string;
  privateKey: string;
  webhookSecret: string;
}

/** Lee y descifra una fila de `github_apps` por su id interno (uuid). Debe llamarse
 * dentro de un `withTenant` ya abierto (RLS resuelve el aislamiento). */
export async function loadGithubAppCredentials(client: QueryableClient, githubAppRowId: string): Promise<GithubAppCredentials> {
  const { rows } = await client.query(
    `SELECT id, github_app_id, slug, client_id, private_key_encrypted, webhook_secret_encrypted
     FROM github_apps WHERE id = $1`,
    [githubAppRowId],
  );
  const row = rows[0];
  if (!row) throw new Error(`github app ${githubAppRowId} not found`);
  return {
    rowId: row.id,
    appId: row.github_app_id,
    slug: row.slug,
    clientId: row.client_id,
    privateKey: decrypt(row.private_key_encrypted).replace(/\\n/g, '\n'),
    webhookSecret: decrypt(row.webhook_secret_encrypted),
  };
}

/** Arma un `GithubAdapter` con las credenciales de la App dueña de `installationId` —
 * un solo JOIN, sin depender de ninguna configuración global. Debe llamarse dentro de
 * un `withTenant` ya abierto. */
export async function buildGithubAdapterForInstallation(client: QueryableClient, installationId: number): Promise<GithubAdapter> {
  const { rows } = await client.query(
    `SELECT ga.id FROM github_installations gi
     JOIN github_apps ga ON ga.id = gi.github_app_id
     WHERE gi.installation_id = $1`,
    [installationId],
  );
  const rowId: string | undefined = rows[0]?.id;
  if (!rowId) {
    throw new Error(`no hay una GitHub App conectada para la instalación ${installationId}`);
  }
  const creds = await loadGithubAppCredentials(client, rowId);
  return new GithubAdapter({ appId: creds.appId, privateKey: creds.privateKey, webhookSecret: creds.webhookSecret });
}
