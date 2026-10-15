import { Injectable, Logger } from '@nestjs/common';
import { getPool, withTenant } from '@devsentinel/database';

export type DeliveryOutcome = 'processed' | 'ignored' | 'rejected' | 'error';

export interface DeliveryEntry {
  deliveryGuid?: string | null;
  event: string | null;
  action?: string | null;
  githubAppId?: string | null;
  githubAppRowId?: string | null;
  organizationId?: string | null;
  outcome: DeliveryOutcome;
  reason: string;
  detail?: string | null;
  repository?: string | null;
  ref?: string | null;
  commitSha?: string | null;
  reviewRunId?: string | null;
  statusCode: number;
  durationMs: number;
  sourceIp?: string | null;
  userAgent?: string | null;
  contentType?: string | null;
  payloadBytes?: number | null;
}

export interface DeliveryFilters {
  /** 'all' | 'unknown' (no coincide con ninguna App) | uuid de una App registrada */
  app?: string;
  outcome?: DeliveryOutcome;
  event?: string;
  before?: string;
  limit?: number;
}

const RETENTION_DAYS = 30;
const PURGE_EVERY_MS = 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OUTCOMES = new Set<string>(['processed', 'ignored', 'rejected', 'error']);

@Injectable()
export class WebhookLogService {
  private readonly logger = new Logger(WebhookLogService.name);
  private lastPurge = 0;

  /** Nunca lanza: perder una fila del registro no puede hacer fallar el webhook en sí. */
  async record(entry: DeliveryEntry): Promise<void> {
    try {
      await getPool().query(
        `INSERT INTO webhook_deliveries
           (delivery_guid, event, action, github_app_id, github_app_row_id, organization_id, outcome, reason, detail,
            repository, ref, commit_sha, review_run_id, status_code, duration_ms, source_ip, user_agent, content_type, payload_bytes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
        [
          entry.deliveryGuid ?? null,
          entry.event,
          entry.action ?? null,
          entry.githubAppId ?? null,
          entry.githubAppRowId ?? null,
          entry.organizationId ?? null,
          entry.outcome,
          entry.reason,
          entry.detail?.slice(0, 500) ?? null,
          entry.repository ?? null,
          entry.ref ?? null,
          entry.commitSha ?? null,
          entry.reviewRunId ?? null,
          entry.statusCode,
          entry.durationMs,
          entry.sourceIp ?? null,
          entry.userAgent?.slice(0, 200) ?? null,
          entry.contentType?.slice(0, 100) ?? null,
          entry.payloadBytes ?? null,
        ],
      );
      void this.purgeIfDue();
    } catch (err) {
      this.logger.error(`no se pudo registrar la entrega de webhook: ${(err as Error).message}`);
    }
  }

  private async purgeIfDue(): Promise<void> {
    if (Date.now() - this.lastPurge < PURGE_EVERY_MS) return;
    this.lastPurge = Date.now();
    try {
      await getPool().query(`DELETE FROM webhook_deliveries WHERE received_at < now() - make_interval(days => $1)`, [RETENTION_DAYS]);
    } catch (err) {
      this.logger.warn(`no se pudo depurar el registro de webhooks: ${(err as Error).message}`);
    }
  }

  /** Entregas de esta organización más las que no pudieron atribuirse a ninguna (App ID
   * desconocido: son justo las que explican "mi App no recibe nada"). El join con
   * review_runs va dentro de withTenant para que RLS solo deje ver los de esta organización. */
  async list(orgId: string, filters: DeliveryFilters) {
    const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 200);
    const app = filters.app && filters.app !== 'all' ? filters.app : null;
    const appRowId = app && UUID.test(app) ? app : null;
    const onlyUnknown = app === 'unknown';
    const outcome = filters.outcome && OUTCOMES.has(filters.outcome) ? filters.outcome : null;
    const before = filters.before && !Number.isNaN(Date.parse(filters.before)) ? filters.before : null;

    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT d.id, d.received_at, d.delivery_guid, d.event, d.action, d.github_app_id, d.github_app_row_id,
                ga.name AS app_name, d.outcome, d.reason, d.detail, d.repository, d.ref, d.commit_sha,
                d.review_run_id, rr.status AS review_status, rr.gate_decision AS review_gate,
                rr.error_message AS review_error, d.status_code, d.duration_ms, d.source_ip, d.user_agent,
                d.content_type, d.payload_bytes
         FROM webhook_deliveries d
         LEFT JOIN github_apps ga ON ga.id = d.github_app_row_id
         LEFT JOIN review_runs rr ON rr.id = d.review_run_id
         WHERE (d.organization_id = $1 OR d.organization_id IS NULL)
           AND ($2::uuid IS NULL OR d.github_app_row_id = $2)
           AND (NOT $3::boolean OR d.github_app_row_id IS NULL)
           AND ($4::text IS NULL OR d.outcome = $4)
           AND ($5::text IS NULL OR d.event = $5)
           AND ($6::timestamptz IS NULL OR d.received_at < $6)
         ORDER BY d.received_at DESC
         LIMIT $7`,
        [orgId, appRowId, onlyUnknown, outcome, filters.event || null, before, limit + 1],
      );
      return { items: rows.slice(0, limit), hasMore: rows.length > limit };
    });
  }

  /** Una tarjeta por App registrada (¿está llegando algo? ¿se acepta?) y, aparte, los App ID
   * que llegan pero no coinciden con ninguna App registrada. */
  async summary(orgId: string) {
    return withTenant(orgId, async (client) => {
      const { rows: apps } = await client.query(
        `SELECT ga.id AS app_row_id, ga.name, ga.github_app_id,
                max(d.received_at) AS last_received_at,
                max(d.received_at) FILTER (WHERE d.outcome = 'processed') AS last_processed_at,
                max(d.received_at) FILTER (WHERE d.event = 'push') AS last_push_at,
                max(d.received_at) FILTER (WHERE d.outcome IN ('rejected', 'error')) AS last_problem_at,
                count(d.id) FILTER (WHERE d.received_at > now() - interval '24 hours')::int AS total_24h,
                count(d.id) FILTER (WHERE d.outcome = 'processed' AND d.received_at > now() - interval '24 hours')::int AS processed_24h,
                count(d.id) FILTER (WHERE d.outcome = 'ignored' AND d.received_at > now() - interval '24 hours')::int AS ignored_24h,
                count(d.id) FILTER (WHERE d.outcome = 'rejected' AND d.received_at > now() - interval '24 hours')::int AS rejected_24h,
                count(d.id) FILTER (WHERE d.outcome = 'error' AND d.received_at > now() - interval '24 hours')::int AS error_24h
         FROM github_apps ga
         LEFT JOIN webhook_deliveries d ON d.github_app_row_id = ga.id
         WHERE ga.organization_id = $1
         GROUP BY ga.id
         ORDER BY ga.created_at`,
        [orgId],
      );
      const { rows: unknownApps } = await client.query(
        `SELECT github_app_id, count(*)::int AS total, max(received_at) AS last_received_at,
                array_agg(DISTINCT reason) AS reasons
         FROM webhook_deliveries
         WHERE organization_id IS NULL AND received_at > now() - interval '7 days'
         GROUP BY github_app_id
         ORDER BY max(received_at) DESC
         LIMIT 10`,
      );
      return { apps, unknownApps, retentionDays: RETENTION_DAYS };
    });
  }
}
