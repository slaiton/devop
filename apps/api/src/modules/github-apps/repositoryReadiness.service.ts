import { Injectable, Logger } from '@nestjs/common';
import { withTenant } from '@devsentinel/database';
import { GithubAdapter, type AppOverview, type InstallationDetails } from '@devsentinel/git-providers';
import { loadGithubAppCredentials, type GithubAppCredentials } from '@devsentinel/github-apps';

/** Lo que DevSentinel necesita de la App instalada para poder recibir y analizar pushes. */
const REQUIRED_EVENTS = ['push', 'pull_request'];
const RECOMMENDED_EVENTS = ['issues', 'issue_comment'];
const REQUIRED_PERMISSIONS: Record<string, 'read' | 'write'> = { contents: 'read', metadata: 'read' };
const RECOMMENDED_PERMISSIONS: Record<string, 'read' | 'write'> = {
  pull_requests: 'write',
  issues: 'write',
  checks: 'write',
};
const PERMISSION_LABEL: Record<string, string> = {
  contents: 'Contents',
  metadata: 'Metadata',
  pull_requests: 'Pull requests',
  issues: 'Issues',
  checks: 'Checks',
};
const LEVEL: Record<string, number> = { read: 1, write: 2, admin: 3 };
const CACHE_TTL_MS = 60_000;

export type ReadinessLevel = 'required' | 'recommended' | 'info';
export type ReadinessStatus = 'ready' | 'attention' | 'blocked' | 'unknown';

export interface ReadinessItem {
  key: string;
  level: ReadinessLevel;
  ok: boolean;
  /** Frase corta para la lista de repos ("Falta aceptar permisos"). */
  title: string;
  /** Explicación completa, con el dato concreto que falta. */
  message: string;
  /** Qué hacer para corregirlo. */
  fix?: string;
  link?: { label: string; href: string };
  /** No se pudo consultar a GitHub (error de red/rate limit): no es lo mismo que "mal configurado". */
  unknown?: boolean;
}

export interface RepositoryReadiness {
  repositoryId: string;
  fullName: string;
  status: ReadinessStatus;
  summary: string;
  items: ReadinessItem[];
  checkedAt: string;
}

interface RepoRow {
  id: string;
  full_name: string;
  github_repo_id: string | number;
  default_branch: string;
  installation_id: string | number;
  account_login: string;
  inst_status: string;
  app_row_id: string | null;
  app_slug: string | null;
  app_name: string | null;
  ignored: string[];
  has_profile: boolean;
  auto_generated_from: string[] | null;
}

interface InstallationSnapshot {
  details?: InstallationDetails;
  repoIds?: Set<number>;
  detailsError?: string;
  reposError?: string;
}

interface AppSnapshot {
  overview?: AppOverview;
  error?: string;
  httpStatus?: number;
}

interface Cached<T> {
  at: number;
  value: T;
}

const httpStatusOf = (err: unknown): number | undefined => (err as { status?: number }).status;

@Injectable()
export class RepositoryReadinessService {
  private readonly logger = new Logger(RepositoryReadinessService.name);
  private readonly appCache = new Map<string, Cached<AppSnapshot>>();
  private readonly installationCache = new Map<string, Cached<InstallationSnapshot>>();

  /** Revisa, repo por repo, si GitHub le va a poder mandar pushes a DevSentinel. Lo que se
   * comparte (la App y cada instalación) se consulta una sola vez por corrida y se guarda
   * 60 s en memoria: la pantalla de repos lo pide al abrirse y no debe gastar rate limit. */
  async check(orgId: string, options: { repositoryId?: string; refresh?: boolean } = {}): Promise<RepositoryReadiness[]> {
    const { rows, credentials, pushStats, eventsSeen } = await this.loadLocalState(orgId, options.repositoryId);
    if (rows.length === 0) return [];

    const apps = new Map<string, AppSnapshot>();
    await Promise.all(
      [...credentials.entries()].map(async ([rowId, creds]) => {
        apps.set(rowId, await this.snapshotApp(orgId, rowId, creds, options.refresh === true));
      }),
    );

    const installations = new Map<string, InstallationSnapshot>();
    const pending = new Map<string, RepoRow>();
    for (const row of rows) {
      if (row.app_row_id && credentials.has(row.app_row_id)) pending.set(`${row.app_row_id}:${row.installation_id}`, row);
    }
    await Promise.all(
      [...pending.entries()].map(async ([key, row]) => {
        installations.set(key, await this.snapshotInstallation(orgId, key, credentials.get(row.app_row_id!)!, Number(row.installation_id), options.refresh === true));
      }),
    );

    const expectedUrl = this.expectedWebhookUrl();
    const checkedAt = new Date().toISOString();
    return rows.map((row) => {
      const items = this.buildItems(row, {
        app: row.app_row_id ? apps.get(row.app_row_id) : undefined,
        installation: row.app_row_id ? installations.get(`${row.app_row_id}:${row.installation_id}`) : undefined,
        expectedUrl,
        lastPush: pushStats.get(row.full_name),
        appEvents: row.app_row_id ? (eventsSeen.get(row.app_row_id) ?? {}) : {},
      });
      const { status, summary } = this.summarize(items);
      return { repositoryId: row.id, fullName: row.full_name, status, summary, items, checkedAt };
    });
  }

  private async loadLocalState(orgId: string, repositoryId?: string) {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT r.id, r.full_name, r.github_repo_id, r.default_branch,
                gi.installation_id, gi.account_login, gi.status AS inst_status,
                ga.id AS app_row_id, ga.slug AS app_slug, ga.name AS app_name,
                COALESCE(qgc.ignored_push_branches, ARRAY[r.default_branch]) AS ignored,
                (pp.id IS NOT NULL) AS has_profile, pp.auto_generated_from
         FROM repositories r
         JOIN github_installations gi ON gi.id = r.github_installation_id
         LEFT JOIN github_apps ga ON ga.id = gi.github_app_id
         LEFT JOIN quality_gate_configs qgc ON qgc.organization_id = r.organization_id AND qgc.repository_id = r.id
         LEFT JOIN project_profiles pp ON pp.repository_id = r.id
         ${repositoryId ? 'WHERE r.id = $1' : ''}
         ORDER BY r.full_name`,
        repositoryId ? [repositoryId] : [],
      );
      const repoRows = rows as RepoRow[];

      const credentials = new Map<string, GithubAppCredentials>();
      for (const appRowId of new Set(repoRows.map((r) => r.app_row_id).filter((id): id is string => Boolean(id)))) {
        try {
          credentials.set(appRowId, await loadGithubAppCredentials(client, appRowId));
        } catch (err) {
          this.logger.warn(`no se pudieron leer las credenciales de la App ${appRowId}: ${(err as Error).message}`);
        }
      }

      const names = repoRows.map((r) => r.full_name);
      const { rows: pushRows } = await client.query(
        `SELECT DISTINCT ON (repository) repository, received_at, outcome, reason
         FROM webhook_deliveries
         WHERE organization_id = $1 AND event = 'push' AND repository = ANY($2)
         ORDER BY repository, received_at DESC`,
        [orgId, names],
      );
      const pushStats = new Map<string, { receivedAt: Date; outcome: string; reason: string }>();
      for (const p of pushRows) pushStats.set(p.repository, { receivedAt: p.received_at, outcome: p.outcome, reason: p.reason });

      const { rows: eventRows } = await client.query(
        `SELECT github_app_row_id, event, count(*)::int AS n
         FROM webhook_deliveries
         WHERE organization_id = $1 AND github_app_row_id IS NOT NULL AND received_at > now() - interval '7 days'
         GROUP BY github_app_row_id, event`,
        [orgId],
      );
      const eventsSeen = new Map<string, Record<string, number>>();
      for (const e of eventRows) {
        const bucket = eventsSeen.get(e.github_app_row_id) ?? {};
        bucket[e.event] = e.n;
        eventsSeen.set(e.github_app_row_id, bucket);
      }

      return { rows: repoRows, credentials, pushStats, eventsSeen };
    });
  }

  private adapterFor(creds: GithubAppCredentials): GithubAdapter {
    return new GithubAdapter({ appId: creds.appId, privateKey: creds.privateKey, webhookSecret: creds.webhookSecret });
  }

  private async snapshotApp(orgId: string, appRowId: string, creds: GithubAppCredentials, refresh: boolean): Promise<AppSnapshot> {
    const key = `${orgId}:${appRowId}`;
    const cached = this.appCache.get(key);
    if (!refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
    let value: AppSnapshot;
    try {
      value = { overview: await this.adapterFor(creds).getAppOverview() };
    } catch (err) {
      value = { error: (err as Error).message, httpStatus: httpStatusOf(err) };
    }
    this.appCache.set(key, { at: Date.now(), value });
    return value;
  }

  private async snapshotInstallation(
    orgId: string,
    key: string,
    creds: GithubAppCredentials,
    installationId: number,
    refresh: boolean,
  ): Promise<InstallationSnapshot> {
    const cacheKey = `${orgId}:${key}`;
    const cached = this.installationCache.get(cacheKey);
    if (!refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
    const adapter = this.adapterFor(creds);
    const value: InstallationSnapshot = {};
    await Promise.all([
      adapter.getInstallationDetails(installationId).then(
        (details) => {
          value.details = details;
        },
        (err) => {
          value.detailsError = (err as Error).message;
        },
      ),
      adapter.listInstallationRepositories(installationId).then(
        (repos) => {
          value.repoIds = new Set(repos.map((r) => r.githubRepoId));
        },
        (err) => {
          value.reposError = (err as Error).message;
        },
      ),
    ]);
    this.installationCache.set(cacheKey, { at: Date.now(), value });
    return value;
  }

  private expectedWebhookUrl(): string {
    const origin = (process.env.PUBLIC_WEB_ORIGIN ?? '').replace(/\/+$/, '');
    return origin ? `${origin}/api/webhooks/github` : '';
  }

  private installationUrl(row: RepoRow, details?: InstallationDetails): string {
    const id = row.installation_id;
    return details?.accountType === 'Organization'
      ? `https://github.com/organizations/${details.accountLogin}/settings/installations/${id}`
      : `https://github.com/settings/installations/${id}`;
  }

  private missingPermissions(
    wanted: Record<string, 'read' | 'write'>,
    granted: Record<string, string>,
  ): { key: string; need: string; has: string | null }[] {
    return Object.entries(wanted)
      .filter(([key, need]) => (LEVEL[granted[key] ?? ''] ?? 0) < LEVEL[need])
      .map(([key, need]) => ({ key, need, has: granted[key] ?? null }));
  }

  private buildItems(
    row: RepoRow,
    ctx: {
      app?: AppSnapshot;
      installation?: InstallationSnapshot;
      expectedUrl: string;
      lastPush?: { receivedAt: Date; outcome: string; reason: string };
      appEvents: Record<string, number>;
    },
  ): ReadinessItem[] {
    const items: ReadinessItem[] = [];
    const appName = row.app_name ?? 'la GitHub App';
    const appSettingsLink = row.app_slug
      ? { label: 'Abrir la App en GitHub', href: `https://github.com/settings/apps/${row.app_slug}/permissions` }
      : undefined;

    // 1) ¿Hay App asociada y se la puede consultar?
    if (!row.app_row_id || !ctx.app) {
      items.push({
        key: 'github_access',
        level: 'required',
        ok: false,
        title: 'Sin GitHub App asociada',
        message: 'Este repositorio no pertenece a ninguna GitHub App conectada, así que no hay credenciales para recibir ni leer sus pushes.',
        fix: 'En Cuentas GitHub, usa "Sincronizar instalaciones existentes" sobre la App que lo tiene instalado.',
        link: { label: 'Ir a Cuentas GitHub', href: '/accounts' },
      });
      return items;
    }
    if (ctx.app.error || !ctx.app.overview) {
      const transient = ctx.app.httpStatus === undefined || ctx.app.httpStatus >= 500 || ctx.app.httpStatus === 429;
      items.push({
        key: 'github_access',
        level: 'required',
        ok: false,
        unknown: transient,
        title: transient ? 'No se pudo consultar GitHub' : 'Credenciales de la App rechazadas',
        message: `GitHub no respondió a la consulta de ${appName}: ${ctx.app.error ?? 'sin detalle'}.`,
        fix: transient
          ? 'Reintenta en un momento con "Reverificar".'
          : 'Revisa el App ID y la private key guardados en Cuentas GitHub.',
        link: transient ? undefined : { label: 'Ir a Cuentas GitHub', href: '/accounts' },
      });
      return items;
    }
    items.push({
      key: 'github_access',
      level: 'required',
      ok: true,
      title: 'Credenciales de la App válidas',
      message: `${appName} se autentica correctamente contra GitHub.`,
    });

    const overview = ctx.app.overview;
    const details = ctx.installation?.details;

    // 2) Webhook apuntando a este servidor.
    if (ctx.expectedUrl) {
      const normalize = (u: string | null) => (u ?? '').replace(/\/+$/, '');
      const ok = normalize(overview.webhookUrl) === normalize(ctx.expectedUrl);
      items.push({
        key: 'webhook_url',
        level: 'required',
        ok,
        title: ok ? 'Webhook apunta a este servidor' : 'Webhook con URL incorrecta',
        message: ok
          ? `El webhook de ${appName} apunta a ${ctx.expectedUrl}.`
          : `El webhook de ${appName} apunta a ${overview.webhookUrl ?? '(vacío)'} y debería apuntar a ${ctx.expectedUrl}.`,
        fix: ok ? undefined : 'En Cuentas GitHub, usa "Diagnosticar webhook" → "Corregir URL y secret".',
        link: ok ? undefined : { label: 'Ir a Cuentas GitHub', href: '/accounts' },
      });
    }

    // 3) Eventos: la App los declara Y la instalación los tiene.
    const eventProblems = (wanted: string[]) => {
      const appMissing = wanted.filter((e) => !overview.subscribedEvents.includes(e));
      const instMissing = details ? wanted.filter((e) => !appMissing.includes(e) && !details.events.includes(e)) : [];
      return { appMissing, instMissing };
    };
    const required = eventProblems(REQUIRED_EVENTS);
    const reqOk = required.appMissing.length === 0 && required.instMissing.length === 0;
    items.push({
      key: 'events',
      level: 'required',
      ok: reqOk,
      title: reqOk
        ? 'Suscrita a push y pull_request'
        : required.appMissing.length
          ? `App sin suscribir: ${required.appMissing.join(', ')}`
          : 'Eventos pendientes de aceptar',
      message: reqOk
        ? 'La App y su instalación reciben los eventos push y pull_request.'
        : required.appMissing.length
          ? `La App no está suscrita a: ${required.appMissing.join(', ')}. Mientras no lo esté, GitHub no manda esos eventos (por eso pueden llegar otros, como check_suite, y ningún push).`
          : `La App declara ${required.instMissing.join(', ')}, pero la instalación de ${row.account_login} todavía no los tiene activos: la cuenta no aceptó el cambio de permisos de la App.`,
      fix: reqOk
        ? undefined
        : required.appMissing.length
          ? 'En github.com → Settings → Developer settings → tu App → Permissions & events → Subscribe to events: marca Push y Pull request (para Push hace falta el permiso Contents: Read).'
          : 'Quien administra la cuenta debe aceptar los permisos nuevos en la página de la instalación.',
      link: reqOk ? undefined : required.appMissing.length ? appSettingsLink : { label: 'Abrir la instalación en GitHub', href: this.installationUrl(row, details) },
    });
    const recommended = eventProblems(RECOMMENDED_EVENTS);
    const recMissing = [...recommended.appMissing, ...recommended.instMissing];
    items.push({
      key: 'events_extra',
      level: 'recommended',
      ok: recMissing.length === 0,
      title: recMissing.length === 0 ? 'Issues y comentarios suscritos' : `Sin suscribir: ${recMissing.join(', ')}`,
      message:
        recMissing.length === 0
          ? 'La App recibe los eventos issues e issue_comment (sincronización de issues).'
          : `Sin ${recMissing.join(', ')} los issues y sus comentarios no se sincronizan en tiempo real.`,
      fix: recMissing.length === 0 ? undefined : 'Suscribe esos eventos en la configuración de la App (requiere el permiso Issues).',
      link: recMissing.length === 0 ? undefined : appSettingsLink,
    });

    // 4) Instalación: estado, permisos aceptados y acceso al repo.
    if (!details) {
      items.push({
        key: 'installation_active',
        level: 'required',
        ok: false,
        unknown: true,
        title: 'No se pudo leer la instalación',
        message: `GitHub no devolvió la instalación de ${row.account_login}: ${ctx.installation?.detailsError ?? 'sin detalle'}.`,
        fix: 'Si la App se desinstaló de esa cuenta, reconéctala desde Cuentas GitHub; si no, reintenta con "Reverificar".',
        link: { label: 'Ir a Cuentas GitHub', href: '/accounts' },
      });
    } else {
      items.push({
        key: 'installation_active',
        level: 'required',
        ok: !details.suspendedAt,
        title: details.suspendedAt ? 'Instalación suspendida' : `Instalada en ${details.accountLogin}`,
        message: details.suspendedAt
          ? `La instalación de ${details.accountLogin} está suspendida desde ${new Date(details.suspendedAt).toLocaleDateString()}: GitHub no envía ningún evento mientras tanto.`
          : `${appName} está instalada y activa en ${details.accountLogin}.`,
        fix: details.suspendedAt ? 'Quien administra la cuenta debe reactivarla desde la página de la instalación.' : undefined,
        link: details.suspendedAt ? { label: 'Abrir la instalación en GitHub', href: this.installationUrl(row, details) } : undefined,
      });

      const describe = (list: { key: string; need: string; has: string | null }[]) =>
        list.map((p) => `${PERMISSION_LABEL[p.key] ?? p.key}: ${p.need === 'write' ? 'Read & write' : 'Read'}${p.has ? ` (hoy: ${p.has})` : ' (hoy: ninguno)'}`).join(', ');
      for (const [key, level, wanted] of [
        ['installation_permissions', 'required', REQUIRED_PERMISSIONS],
        ['installation_permissions_extra', 'recommended', RECOMMENDED_PERMISSIONS],
      ] as const) {
        const missing = this.missingPermissions(wanted, details.permissions);
        const declaredByApp = missing.filter((p) => (LEVEL[overview.permissions[p.key] ?? ''] ?? 0) >= LEVEL[p.need]);
        const notDeclared = missing.filter((p) => !declaredByApp.includes(p));
        const ok = missing.length === 0;
        items.push({
          key,
          level,
          ok,
          title: ok
            ? level === 'required'
              ? 'Permisos de lectura aceptados'
              : 'Permisos de PR, issues y checks aceptados'
            : declaredByApp.length
              ? 'Permisos pendientes de aceptar'
              : 'La App no pide permisos necesarios',
          message: ok
            ? `La instalación tiene ${level === 'required' ? 'Contents y Metadata en lectura' : 'Pull requests, Issues y Checks con escritura'}.`
            : [
                declaredByApp.length
                  ? `La App ya los declara, pero la cuenta ${row.account_login} no los aceptó todavía: ${describe(declaredByApp)}. Hasta que se acepten, GitHub trata a la instalación con los permisos viejos.`
                  : '',
                notDeclared.length ? `La App no los tiene configurados: ${describe(notDeclared)}.` : '',
              ]
                .filter(Boolean)
                .join(' '),
          fix: ok
            ? undefined
            : declaredByApp.length
              ? 'Quien administra la cuenta debe abrir la instalación y aceptar los permisos nuevos ("Review request"). GitHub también lo avisa por correo al dueño de la cuenta.'
              : 'En github.com → tu App → Permissions & events, agrega esos permisos; luego acepta la actualización en la instalación.',
          link: ok ? undefined : declaredByApp.length ? { label: 'Abrir la instalación en GitHub', href: this.installationUrl(row, details) } : appSettingsLink,
        });
      }
    }

    if (ctx.installation?.repoIds) {
      const inside = ctx.installation.repoIds.has(Number(row.github_repo_id));
      items.push({
        key: 'repo_in_installation',
        level: 'required',
        ok: inside,
        title: inside ? 'Repo incluido en la instalación' : 'Repo fuera de la instalación',
        message: inside
          ? `La instalación de ${row.account_login} da acceso a ${row.full_name}.`
          : `La instalación de ${row.account_login} ya no incluye ${row.full_name}: GitHub no envía eventos de repos fuera de ella.`,
        fix: inside ? undefined : 'Agrega el repo en "Repository access" de la instalación.',
        link: inside ? undefined : { label: 'Abrir la instalación en GitHub', href: this.installationUrl(row, details) },
      });
    } else if (ctx.installation?.reposError) {
      items.push({
        key: 'repo_in_installation',
        level: 'required',
        ok: false,
        unknown: true,
        title: 'No se pudo listar los repos de la instalación',
        message: `GitHub no devolvió los repos accesibles: ${ctx.installation.reposError}.`,
        fix: 'Reintenta con "Reverificar". Si persiste, suele ser el permiso Metadata sin aceptar.',
      });
    }

    // 5) Política de ramas (informativo): por defecto se omite la rama principal.
    items.push({
      key: 'branch_policy',
      level: 'info',
      ok: true,
      title: `Se omiten pushes a: ${row.ignored.join(', ') || 'ninguna rama'}`,
      message: row.ignored.length
        ? `Los pushes a ${row.ignored.join(', ')} llegan pero no se analizan (están en la lista de ramas omitidas del repo). Para probar, empuja a otra rama, por ejemplo feature/prueba.`
        : 'Se analiza el push a cualquier rama.',
      link: { label: 'Cambiar ramas omitidas', href: `/repositories/${row.id}/settings` },
    });

    // 6) ¿Ya llegó algún push de este repo?
    const seen = ctx.appEvents;
    const otherEvents = Object.entries(seen).filter(([event]) => event !== 'push');
    items.push(
      ctx.lastPush
        ? {
            key: 'push_seen',
            level: 'recommended',
            ok: true,
            title: 'Ya llegaron pushes de este repo',
            message: `Último push recibido el ${new Date(ctx.lastPush.receivedAt).toLocaleString()} (${ctx.lastPush.outcome}: ${ctx.lastPush.reason}).`,
            link: { label: 'Ver el registro de webhooks', href: '/webhooks' },
          }
        : {
            key: 'push_seen',
            level: 'recommended',
            ok: false,
            title: 'Aún no llega ningún push',
            message:
              otherEvents.length && !seen.push
                ? `En los últimos 7 días esta App entregó ${otherEvents.map(([e, n]) => `${e} ×${n}`).join(', ')} pero ningún push: casi siempre es el evento push sin suscribir o el permiso Contents sin aceptar en la instalación.`
                : 'Todavía no se registró ningún push de este repo en los últimos 30 días. Haz un push a una rama que no esté omitida y vuelve a verificar.',
            link: { label: 'Ver el registro de webhooks', href: '/webhooks' },
          },
    );

    // 7) Contexto del proyecto.
    items.push({
      key: 'project_context',
      level: 'recommended',
      ok: row.has_profile,
      title: row.has_profile ? 'Perfil del proyecto listo' : 'Sin contexto del proyecto',
      message: row.has_profile
        ? row.auto_generated_from
          ? `El perfil se generó con IA desde ${row.auto_generated_from.join(', ')}; conviene revisarlo.`
          : 'El perfil del proyecto fue configurado por una persona.'
        : 'Sin perfil del proyecto, la IA revisa con criterios generales y no conoce el stack ni las reglas del equipo.',
      fix: row.has_profile ? undefined : 'Usa "Generar contexto" en la pestaña Perfil del proyecto: lee el README y los archivos del repo.',
      link: row.has_profile ? undefined : { label: 'Generar contexto', href: `/repositories/${row.id}/project-profile` },
    });

    return items;
  }

  private summarize(items: ReadinessItem[]): { status: ReadinessStatus; summary: string } {
    const failedRequired = items.filter((i) => i.level === 'required' && !i.ok);
    if (failedRequired.length > 0) {
      const onlyUnknown = failedRequired.every((i) => i.unknown);
      return { status: onlyUnknown ? 'unknown' : 'blocked', summary: failedRequired.find((i) => !i.unknown)?.title ?? failedRequired[0].title };
    }
    const failedRecommended = items.filter((i) => i.level === 'recommended' && !i.ok);
    if (failedRecommended.length > 0) return { status: 'attention', summary: failedRecommended[0].title };
    return { status: 'ready', summary: 'Listo para recibir pushes' };
  }
}
