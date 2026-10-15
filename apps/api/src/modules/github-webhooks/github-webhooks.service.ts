import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { GithubAdapter } from '@devsentinel/git-providers';
import { getPool, withTenant } from '@devsentinel/database';
import { decrypt } from '@devsentinel/settings';
import { upsertInstallationRepositories } from '@devsentinel/github-apps';
import { REVIEW_QUEUE_NAME, type ReviewJobPayload } from '@devsentinel/event-contracts';
import { IssuesSyncService } from './issuesSync.service';
import { ignored, processed, type WebhookOutcome } from './webhookOutcome';

export interface WebhookAppContext {
  organizationId: string;
  githubAppRowId: string;
}

export type VerifyResult =
  | { ok: true; ctx: WebhookAppContext }
  | {
      ok: false;
      reason: 'no_raw_body' | 'missing_app_id' | 'unknown_app' | 'bad_signature';
      detail: string;
      githubAppRowId?: string;
      organizationId?: string;
    };

@Injectable()
export class GithubWebhooksService {
  private readonly logger = new Logger(GithubWebhooksService.name);

  constructor(
    @InjectQueue(REVIEW_QUEUE_NAME) private readonly queue: Queue<ReviewJobPayload>,
    private readonly issuesSync: IssuesSyncService,
  ) {}

  /** Resuelve QUÉ GitHub App envió este webhook a partir del App ID que GitHub manda
   * en el header `X-GitHub-Hook-Installation-Target-ID`, y solo entonces verifica la
   * firma HMAC con el secret de ESA App — nunca al revés, para no aceptar un payload
   * antes de saber con qué secret validarlo. `github_apps` tiene RLS, así que resolver
   * organización + secret sin conocer el tenant exige la función SECURITY DEFINER
   * `resolve_github_app` (migración 0025, mismo patrón que
   * `resolve_organization_for_installation`). Varias Apps comparten esta misma URL de
   * webhook sin problema — lo que las distingue es este header, no la ruta — pero eso
   * hace que un typo en el App ID o el webhook secret guardados en `github_apps` se vea
   * solo como un 401 del lado de GitHub: por eso el motivo exacto se devuelve y queda en
   * el registro de entregas (/webhooks) además del log del contenedor. */
  async verifyAndResolve(
    rawBody: Buffer | undefined,
    signature: string | undefined,
    githubAppId: string | undefined,
  ): Promise<VerifyResult> {
    if (!rawBody) {
      return { ok: false, reason: 'no_raw_body', detail: 'la petición llegó sin cuerpo' };
    }
    if (!githubAppId) {
      this.logger.warn('webhook rechazado: falta el header X-GitHub-Hook-Installation-Target-ID');
      return {
        ok: false,
        reason: 'missing_app_id',
        detail: 'falta el header X-GitHub-Hook-Installation-Target-ID (no es un webhook de una GitHub App, o un proxy lo está quitando)',
      };
    }
    const { rows } = await getPool().query(
      'SELECT organization_id, id, webhook_secret_encrypted FROM resolve_github_app($1)',
      [githubAppId],
    );
    const row = rows[0];
    if (!row) {
      this.logger.warn(
        `webhook rechazado: ninguna GitHub App registrada tiene el App ID '${githubAppId}' — revisá que coincida exactamente con el App ID real en github.com/settings/apps`,
      );
      return {
        ok: false,
        reason: 'unknown_app',
        detail: `ninguna GitHub App registrada tiene el App ID ${githubAppId}: revisa que el App ID guardado en Cuentas GitHub sea el numérico de la App (no el Client ID ni el ID de instalación)`,
      };
    }

    const webhookSecret = decrypt(row.webhook_secret_encrypted);
    const adapter = new GithubAdapter({ appId: githubAppId, privateKey: '', webhookSecret });
    if (!adapter.verifyWebhookSignature(rawBody, signature)) {
      this.logger.warn(
        `webhook rechazado: firma inválida para la App ID '${githubAppId}' (organización ${row.organization_id}) — el webhook secret guardado en /accounts no coincide con el configurado en github.com para esta App`,
      );
      return {
        ok: false,
        reason: 'bad_signature',
        detail: 'la firma no coincide: el webhook secret guardado en Cuentas GitHub no es el que tiene configurado esta App en github.com',
        githubAppRowId: row.id as string,
        organizationId: row.organization_id as string,
      };
    }

    return { ok: true, ctx: { organizationId: row.organization_id as string, githubAppRowId: row.id as string } };
  }

  async handleEvent(event: string, payload: any, ctx: WebhookAppContext): Promise<WebhookOutcome> {
    this.logger.log(`webhook aceptado: evento '${event}' para la organización ${ctx.organizationId}`);
    const action: string | undefined = typeof payload?.action === 'string' ? payload.action : undefined;
    const withAction = (o: WebhookOutcome): WebhookOutcome => ({ ...o, action: o.action ?? action });

    switch (event) {
      case 'ping':
        return processed('ping', { detail: 'ping de GitHub recibido: la ruta del webhook y el secret funcionan' });
      case 'installation':
        if (action === 'created') return withAction(await this.handleInstallationCreated(payload, ctx));
        if (action === 'deleted') return withAction(await this.handleInstallationDeleted(payload, ctx));
        return withAction(ignored('ignored_action', { detail: `installation.${action ?? '?'} no requiere ninguna acción` }));
      case 'installation_repositories':
        return withAction(await this.handleInstallationRepositories(payload, ctx));
      case 'push':
        return withAction(await this.handlePush(payload, ctx));
      case 'pull_request':
        if (action && ['opened', 'synchronize', 'reopened'].includes(action)) {
          return withAction(await this.handlePullRequest(payload, ctx));
        }
        return withAction(
          ignored('ignored_action', {
            detail: `pull_request.${action ?? '?'} no dispara análisis (solo opened, synchronize y reopened)`,
            repository: payload?.repository?.full_name,
          }),
        );
      case 'issues':
        return withAction(await this.issuesSync.handleIssueEvent(payload, ctx));
      case 'issue_comment':
        return withAction(await this.issuesSync.handleIssueCommentEvent(payload, ctx));
      default:
        return ignored('ignored_event', {
          detail: `DevSentinel no usa el evento '${event}' (si lo tienes suscrito en la App, puedes quitarlo)`,
        });
    }
  }

  private async handleInstallationCreated(payload: any, ctx: WebhookAppContext): Promise<WebhookOutcome> {
    const accountLogin: string = payload.installation.account.login;
    const installationId: number = payload.installation.id;

    await withTenant(ctx.organizationId, async (client) => {
      await client.query(
        `INSERT INTO github_installations (organization_id, installation_id, account_login, github_app_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (installation_id) DO UPDATE SET status = 'active', github_app_id = $4`,
        [ctx.organizationId, installationId, accountLogin, ctx.githubAppRowId],
      );
    });

    const repos: any[] = payload.repositories ?? [];
    await this.upsertRepositories(ctx.organizationId, installationId, repos);
    return processed('installation_created', { detail: `cuenta ${accountLogin} conectada con ${repos.length} repositorio(s)` });
  }

  private async handleInstallationDeleted(payload: any, ctx: WebhookAppContext): Promise<WebhookOutcome> {
    const installationId: number = payload.installation.id;
    await withTenant(ctx.organizationId, async (client) => {
      await client.query(`UPDATE github_installations SET status = 'revoked' WHERE installation_id = $1`, [
        installationId,
      ]);
    });
    return processed('installation_revoked', { detail: 'la App se desinstaló de esa cuenta' });
  }

  private async handleInstallationRepositories(payload: any, ctx: WebhookAppContext): Promise<WebhookOutcome> {
    const installationId: number = payload.installation.id;
    const added: any[] = payload.repositories_added ?? [];
    await this.upsertRepositories(ctx.organizationId, installationId, added);
    return processed('installation_repos_updated', { detail: `${added.length} repositorio(s) agregado(s) a la instalación` });
  }

  /** Regla clave: ningún push válido se descarta en silencio. Los únicos descartes son
   * deliberados y quedan en el registro de entregas con su motivo: tags, borrado de rama,
   * ramas que el admin configuró para omitir, y duplicados de un commit que ya está en
   * análisis (p. ej. cuando dos Apps instaladas en la misma cuenta mandan el mismo push, o
   * GitHub reenvía la entrega). Un repo que todavía no estaba sincronizado NO es motivo
   * para perder el push: se registra al vuelo con los datos del propio evento. */
  private async handlePush(payload: any, ctx: WebhookAppContext): Promise<WebhookOutcome> {
    const fullName = String(payload.repository?.full_name);
    const ref = String(payload.ref ?? '');
    const installationId: number | undefined = payload.installation?.id;
    if (!installationId) {
      this.logger.warn(`push de ${fullName} sin installation.id en el payload — no se puede analizar`);
      return ignored('no_installation', {
        detail: 'el payload no trae installation.id: no es un evento de una GitHub App instalada',
        repository: fullName,
        ref,
      });
    }
    const orgId = ctx.organizationId;
    const [owner, repo] = fullName.split('/');

    if (!ref.startsWith('refs/heads/')) {
      this.logger.log(`push ignorado: ${fullName} ${ref} no es una rama`);
      return ignored('not_a_branch', { detail: `${ref} no es una rama (¿un tag?)`, repository: fullName, ref });
    }
    const commitSha: string = payload.after;
    if (!commitSha || commitSha === '0000000000000000000000000000000000000000') {
      this.logger.log(`push ignorado: ${fullName} ${ref} fue un borrado de rama`);
      return ignored('branch_deleted', { detail: 'el push borró la rama', repository: fullName, ref });
    }
    const branch = ref.slice('refs/heads/'.length);

    let repository = await this.getRepositoryForPush(orgId, payload.repository.id);
    let registeredNow = false;
    if (!repository) {
      repository = await this.registerRepositoryFromEvent(ctx, payload, installationId, owner);
      if (!repository) {
        return {
          outcome: 'error',
          reason: 'repo_unregistered',
          detail: 'el repositorio no estaba sincronizado y no se pudo registrar (¿ya existe en otra organización?)',
          repository: fullName,
          ref,
          commitSha,
        };
      }
      registeredNow = true;
    }

    if (repository.ignored_push_branches.includes(branch)) {
      this.logger.log(`push ignorado: ${fullName}@${branch} está en la lista de ramas a omitir`);
      return ignored('ignored_branch', {
        detail: `la rama "${branch}" está en la lista de ramas a omitir de este repo (se cambia en la pestaña Configuración del repositorio); por defecto se omite la rama principal`,
        repository: fullName,
        ref,
        commitSha,
      });
    }

    if (await this.hasActiveReviewRunForPush(orgId, repository.id, commitSha)) {
      this.logger.log(`push duplicado: ${fullName}@${commitSha.slice(0, 7)} ya está analizado o en análisis`);
      return ignored('duplicate', {
        detail: 'ese commit ya tiene un análisis en curso o terminado (p. ej. lo mandó otra App instalada en el mismo repo, o GitHub reenvió la entrega)',
        repository: fullName,
        ref,
        commitSha,
      });
    }

    const authorName: string | null = payload.head_commit?.author?.name ?? null;
    const authorEmail: string | null = payload.head_commit?.author?.email ?? null;
    const developerId = await this.resolveDeveloper(orgId, { email: authorEmail, name: authorName });

    const reviewRunId = await this.createReviewRun(
      orgId,
      repository.id,
      null,
      commitSha,
      'push',
      branch,
      authorName,
      authorEmail,
      developerId,
    );

    await this.enqueueReview(orgId, {
      reviewRunId,
      organizationId: orgId,
      repositoryId: repository.id,
      installationId,
      owner,
      repo,
      commitSha,
      branch,
    });
    return processed(registeredNow ? 'repo_registered_queued' : 'queued', {
      detail: registeredNow ? 'repositorio registrado al vuelo y análisis encolado' : 'análisis encolado',
      repository: fullName,
      ref,
      commitSha,
      reviewRunId,
    });
  }

  /** Encola con reintentos (backoff exponencial): un LLM caído o un rate limit de GitHub
   * no deben hacer que el push se pierda. Si ni siquiera se puede encolar (Redis caído) el
   * review_run queda en 'failed' y el error sube — GitHub marca la entrega como fallida y
   * se puede reenviar desde /accounts. */
  private async enqueueReview(orgId: string, job: ReviewJobPayload): Promise<void> {
    try {
      await this.queue.add(REVIEW_QUEUE_NAME, job, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
      });
    } catch (err) {
      await withTenant(orgId, async (client) => {
        await client.query(
          `UPDATE review_runs SET status = 'failed', error_message = $1, completed_at = now() WHERE id = $2`,
          [`no se pudo encolar el análisis: ${(err as Error).message}`, job.reviewRunId],
        );
      });
      throw err;
    }
  }

  private async hasActiveReviewRunForPush(orgId: string, repositoryId: string, commitSha: string): Promise<boolean> {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT 1 FROM review_runs
         WHERE repository_id = $1 AND commit_sha = $2 AND trigger = 'push' AND status IN ('running', 'completed')
         LIMIT 1`,
        [repositoryId, commitSha],
      );
      return rows.length > 0;
    });
  }

  /** Alta al vuelo del repo (y de su instalación) a partir de un push/PR de un repo que
   * todavía no estaba en `repositories` — por ejemplo uno creado después de instalar la
   * App con acceso a "todos los repos", cuyo evento `installation_repositories` no llegó.
   * La organización es la dueña de la App que mandó el webhook. */
  private async registerRepositoryFromEvent(
    ctx: WebhookAppContext,
    payload: any,
    installationId: number,
    owner: string,
  ): Promise<{ id: string; full_name: string; ignored_push_branches: string[] } | null> {
    const fullName = String(payload.repository.full_name);
    try {
      await getPool().query('SELECT link_installation_to_organization($1, $2, $3, $4)', [
        installationId,
        ctx.organizationId,
        owner,
        ctx.githubAppRowId,
      ]);
      await this.upsertRepositories(ctx.organizationId, installationId, [
        { id: payload.repository.id, full_name: fullName, default_branch: payload.repository.default_branch },
      ]);
      const repository = await this.getRepositoryForPush(ctx.organizationId, payload.repository.id);
      if (repository) {
        this.logger.log(`repo ${fullName} no estaba sincronizado — registrado automáticamente desde el evento`);
      } else {
        this.logger.error(
          `no se pudo registrar ${fullName}: ya existe en otra organización (¿la misma cuenta instalada en dos Apps de organizaciones distintas?)`,
        );
      }
      return repository;
    } catch (err) {
      this.logger.error(`no se pudo registrar ${fullName} desde el evento: ${(err as Error).message}`, (err as Error).stack);
      return null;
    }
  }

  private async handlePullRequest(payload: any, ctx: WebhookAppContext): Promise<WebhookOutcome> {
    const fullName = String(payload.repository?.full_name);
    const installationId: number | undefined = payload.installation?.id;
    if (!installationId) {
      this.logger.warn(`pull_request de ${fullName} sin installation.id en el payload — no se puede analizar`);
      return ignored('no_installation', {
        detail: 'el payload no trae installation.id: no es un evento de una GitHub App instalada',
        repository: fullName,
      });
    }
    const orgId = ctx.organizationId;

    const [owner, repo] = fullName.split('/');
    let repositoryId = await this.getRepositoryId(orgId, payload.repository.id);
    if (!repositoryId) {
      repositoryId = (await this.registerRepositoryFromEvent(ctx, payload, installationId, owner))?.id ?? null;
      if (!repositoryId) {
        return {
          outcome: 'error',
          reason: 'repo_unregistered',
          detail: 'el repositorio no estaba sincronizado y no se pudo registrar (¿ya existe en otra organización?)',
          repository: fullName,
        };
      }
    }

    const pr = payload.pull_request;
    const ref = pr.head.ref as string;
    const pullRequestId = await withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO pull_requests (organization_id, repository_id, github_pr_number, title, source_branch, target_branch, author_login, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')
         ON CONFLICT (repository_id, github_pr_number)
         DO UPDATE SET title = $4, status = 'open'
         RETURNING id`,
        [orgId, repositoryId, pr.number, pr.title, pr.head.ref, pr.base.ref, pr.user.login],
      );
      return rows[0].id as string;
    });

    // Si este commit ya fue analizado (p. ej. vino de un push a la rama origen y el PR
    // se creó/detectó a partir de ese análisis), se reutiliza — no se vuelve a gastar
    // un análisis de IA para el mismo commit.
    const existingRunId = await this.findCompletedReviewRunForCommit(orgId, repositoryId, pr.head.sha);
    if (existingRunId) {
      await withTenant(orgId, async (client) => {
        await client.query(`UPDATE review_runs SET pull_request_id = $1 WHERE id = $2 AND pull_request_id IS NULL`, [
          pullRequestId,
          existingRunId,
        ]);
      });
      return processed('reused_review', {
        detail: `PR #${pr.number} ligado al análisis ya existente de ese commit`,
        repository: fullName,
        ref,
        commitSha: pr.head.sha,
        reviewRunId: existingRunId,
      });
    }

    const developerId = await this.resolveDeveloper(orgId, { githubLogin: pr.user.login });

    const reviewRunId = await this.createReviewRun(
      orgId,
      repositoryId,
      pullRequestId,
      pr.head.sha,
      'pull_request',
      pr.head.ref,
      null,
      null,
      developerId,
    );

    await this.enqueueReview(orgId, {
      reviewRunId,
      organizationId: orgId,
      repositoryId,
      installationId,
      owner,
      repo,
      commitSha: pr.head.sha,
      branch: pr.head.ref,
      pullNumber: pr.number,
    });
    return processed('queued', {
      detail: `análisis del PR #${pr.number} encolado`,
      repository: fullName,
      ref,
      commitSha: pr.head.sha,
      reviewRunId,
    });
  }

  private async findCompletedReviewRunForCommit(
    orgId: string,
    repositoryId: string,
    commitSha: string,
  ): Promise<string | null> {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT id FROM review_runs
         WHERE repository_id = $1 AND commit_sha = $2 AND status = 'completed'
         ORDER BY started_at DESC
         LIMIT 1`,
        [repositoryId, commitSha],
      );
      return rows[0]?.id ?? null;
    });
  }

  private async getRepositoryId(orgId: string, githubRepoId: number): Promise<string | null> {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query('SELECT id FROM repositories WHERE github_repo_id = $1', [githubRepoId]);
      return rows[0]?.id ?? null;
    });
  }

  private async getRepositoryForPush(
    orgId: string,
    githubRepoId: number,
  ): Promise<{ id: string; full_name: string; ignored_push_branches: string[] } | null> {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT r.id, r.full_name,
                COALESCE(qgc.ignored_push_branches, ARRAY[r.default_branch]) AS ignored_push_branches
         FROM repositories r
         LEFT JOIN quality_gate_configs qgc
           ON qgc.organization_id = r.organization_id AND qgc.repository_id = r.id
         WHERE r.github_repo_id = $1`,
        [githubRepoId],
      );
      return rows[0] ?? null;
    });
  }

  /** login de GitHub (PRs) o email de commit (pushes) — no siempre hay ambos. */
  private async resolveDeveloper(
    orgId: string,
    identity: { githubLogin?: string | null; email?: string | null; name?: string | null },
  ): Promise<string | null> {
    const githubLogin = identity.githubLogin ?? null;
    const email = identity.email ?? null;
    if (!githubLogin && !email) return null;

    return withTenant(orgId, async (client) => {
      const existing = await client.query(
        `SELECT id FROM developers WHERE organization_id = $1 AND (($2::text IS NOT NULL AND github_login = $2) OR ($3::text IS NOT NULL AND email = $3))`,
        [orgId, githubLogin, email],
      );
      if (existing.rows[0]) return existing.rows[0].id as string;

      const { rows } = await client.query(
        `INSERT INTO developers (organization_id, github_login, email, display_name)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [orgId, githubLogin, email, identity.name ?? githubLogin ?? email],
      );
      return rows[0].id as string;
    });
  }

  private async upsertRepositories(orgId: string, installationId: number, repos: any[]): Promise<void> {
    if (!repos.length) return;
    await withTenant(orgId, async (client) => {
      const { rows } = await client.query('SELECT id FROM github_installations WHERE installation_id = $1', [
        installationId,
      ]);
      const githubInstallationId = rows[0]?.id;
      if (!githubInstallationId) return;

      await upsertInstallationRepositories(
        client,
        orgId,
        githubInstallationId,
        repos.map((repo) => ({
          githubRepoId: repo.id,
          fullName: repo.full_name,
          defaultBranch: repo.default_branch ?? 'main',
        })),
      );
    });
  }

  private async createReviewRun(
    orgId: string,
    repositoryId: string,
    pullRequestId: string | null,
    commitSha: string,
    trigger: 'push' | 'pull_request',
    branch: string,
    authorName: string | null,
    authorEmail: string | null,
    developerId: string | null,
  ): Promise<string> {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO review_runs
           (organization_id, repository_id, pull_request_id, commit_sha, trigger, branch, author_name, author_email, developer_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'running')
         RETURNING id`,
        [orgId, repositoryId, pullRequestId, commitSha, trigger, branch, authorName, authorEmail, developerId],
      );
      return rows[0].id as string;
    });
  }
}
