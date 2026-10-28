import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { withTenant } from '@devsentinel/database';
import { DEFAULT_NOTIFICATION_SOUND, isNotificationSound } from './sounds';

/** Lo que recibe el navegador cuando termina el análisis de un commit (o falla definitivamente). */
export interface ReviewEvent {
  type: 'review_completed' | 'review_failed';
  reviewRunId: string;
  repositoryId: string;
  repository: string;
  branch: string | null;
  commitSha: string;
  trigger: 'push' | 'pull_request' | 'manual';
  prNumber: number | null;
  gate: 'apto' | 'requiere_revision' | 'no_apto' | null;
  score: number | null;
  risk: 'low' | 'medium' | 'high' | null;
  blockingCount: number;
  /** Preguntas de la IA que esperan respuesta del desarrollador. */
  questionCount: number;
  author: { developerId: string | null; name: string | null };
  /** Tono del AUTOR del commit (lo configura el admin por desarrollador). */
  sound: { id: string; volume: number; muted: boolean };
  completedAt: string;
}

interface Subscriber {
  userId: string;
  role: 'admin' | 'user';
  push: (event: ReviewEvent) => void;
}

interface Row {
  id: string;
  status: 'completed' | 'failed';
  gate_decision: ReviewEvent['gate'];
  quality_score: number | null;
  risk_level: ReviewEvent['risk'];
  branch: string | null;
  commit_sha: string;
  trigger: ReviewEvent['trigger'];
  completed_at: Date;
  repository_id: string;
  full_name: string;
  pr_number: number | null;
  developer_id: string | null;
  author_name: string | null;
  display_name: string | null;
  github_login: string | null;
  dev_user_id: string | null;
  notification_sound: string | null;
  notification_volume: string | null;
  notification_muted: boolean | null;
  blocking_count: number;
  question_count: number;
}

/** Margen hacia atrás al consultar: una transacción que empezó antes pero confirmó después (completed_at usa
 * el `now()` de su inicio) no se pierde; los ya enviados se descartan por id. */
const OVERLAP_MS = 8_000;
const SEEN_TTL_MS = 120_000;

/**
 * Aviso en vivo de "terminó el análisis de un commit". El worker no habla con la API (son procesos distintos), así que
 * la API mira la base: cada pocos segundos, por cada organización con alguien conectado, busca análisis terminados desde
 * la última vez y los reparte a esas conexiones (SSE). Un admin recibe todos; un usuario solo los de commits suyos
 * (su cuenta vinculada al desarrollador autor). Solo hay consultas mientras alguien está conectado.
 */
@Injectable()
export class NotificationsService implements OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly cursors = new Map<string, number>();
  /** Desde cuándo hay alguien conectado por organización: lo anterior no es "nuevo" para nadie. */
  private readonly floors = new Map<string, number>();
  private readonly seen = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly pollMs = Number(process.env.NOTIFY_POLL_MS) || 2_000;

  subscribe(orgId: string, subscriber: Subscriber): () => void {
    let set = this.subscribers.get(orgId);
    if (!set) {
      set = new Set();
      this.subscribers.set(orgId, set);
      this.cursors.set(orgId, Date.now()); // solo lo que termine desde ahora
      this.floors.set(orgId, Date.now());
    }
    set.add(subscriber);
    if (!this.timer) this.timer = setInterval(() => void this.tick(), this.pollMs);

    return () => {
      const current = this.subscribers.get(orgId);
      current?.delete(subscriber);
      if (current && current.size === 0) {
        this.subscribers.delete(orgId);
        this.cursors.delete(orgId);
        this.floors.delete(orgId);
      }
      if (this.subscribers.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  connectionCount(): number {
    return [...this.subscribers.values()].reduce((n, s) => n + s.size, 0);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      for (const [id, at] of this.seen) if (now - at > SEEN_TTL_MS) this.seen.delete(id);

      for (const [orgId, subs] of [...this.subscribers.entries()]) {
        const cursor = this.cursors.get(orgId) ?? now;
        let rows: Row[];
        try {
          rows = await this.fetchSince(orgId, new Date(cursor - OVERLAP_MS));
        } catch (err) {
          this.logger.warn(`no se pudieron consultar los análisis terminados de ${orgId}: ${(err as Error).message}`);
          continue;
        }
        const floor = this.floors.get(orgId) ?? 0;
        let maxCompleted = cursor;
        for (const row of rows) {
          if (row.completed_at.getTime() < floor) continue; // terminó antes de que alguien estuviera conectado
          maxCompleted = Math.max(maxCompleted, row.completed_at.getTime());
          if (this.seen.has(row.id)) continue;
          this.seen.set(row.id, now);
          const { event, authorUserId } = this.toEvent(row);
          for (const sub of subs) {
            if (sub.role === 'admin' || (authorUserId && authorUserId === sub.userId)) {
              try {
                sub.push(event);
              } catch {
                // una conexión rota no debe afectar a las demás
              }
            }
          }
        }
        this.cursors.set(orgId, maxCompleted);
      }
    } finally {
      this.running = false;
    }
  }

  private async fetchSince(orgId: string, since: Date): Promise<Row[]> {
    return withTenant(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT rr.id, rr.status, rr.gate_decision, rr.quality_score, rr.risk_level, rr.branch, rr.commit_sha, rr.trigger,
                rr.completed_at, rr.repository_id, r.full_name, pr.github_pr_number AS pr_number,
                rr.developer_id, rr.author_name, d.display_name, d.github_login, d.user_id AS dev_user_id,
                d.notification_sound, d.notification_volume, d.notification_muted,
                (SELECT count(*)::int FROM findings f WHERE f.review_run_id = rr.id AND f.blocking) AS blocking_count,
                (SELECT count(*)::int FROM findings f WHERE f.review_run_id = rr.id AND f.status = 'awaiting_clarification') AS question_count
         FROM review_runs rr
         JOIN repositories r ON r.id = rr.repository_id
         LEFT JOIN developers d ON d.id = rr.developer_id
         LEFT JOIN pull_requests pr ON pr.id = rr.pull_request_id
         WHERE rr.completed_at > $1 AND rr.status IN ('completed', 'failed')
         ORDER BY rr.completed_at
         LIMIT 100`,
        [since],
      );
      return rows as Row[];
    });
  }

  private toEvent(row: Row): { event: ReviewEvent; authorUserId: string | null } {
    const sound = row.notification_sound && isNotificationSound(row.notification_sound) ? row.notification_sound : DEFAULT_NOTIFICATION_SOUND;
    return {
      authorUserId: row.dev_user_id,
      event: {
        type: row.status === 'failed' ? 'review_failed' : 'review_completed',
        reviewRunId: row.id,
        repositoryId: row.repository_id,
        repository: row.full_name,
        branch: row.branch,
        commitSha: row.commit_sha,
        trigger: row.trigger,
        prNumber: row.pr_number,
        gate: row.gate_decision,
        score: row.quality_score,
        risk: row.risk_level,
        blockingCount: row.blocking_count,
        questionCount: row.question_count,
        author: { developerId: row.developer_id, name: row.display_name ?? row.github_login ?? row.author_name },
        sound: { id: sound, volume: row.notification_volume === null ? 0.8 : Number(row.notification_volume), muted: row.notification_muted ?? false },
        completedAt: row.completed_at.toISOString(),
      },
    };
  }
}
