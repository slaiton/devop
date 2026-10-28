'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { apiJson } from '../../lib/clientApi';

export interface AppSummary {
  app_row_id: string;
  name: string;
  github_app_id: string;
  last_received_at: string | null;
  last_processed_at: string | null;
  last_push_at: string | null;
  last_problem_at: string | null;
  total_24h: number;
  processed_24h: number;
  ignored_24h: number;
  rejected_24h: number;
  error_24h: number;
}

export interface UnknownAppSummary {
  github_app_id: string | null;
  total: number;
  last_received_at: string;
  reasons: string[];
}

export interface Summary {
  apps: AppSummary[];
  unknownApps: UnknownAppSummary[];
  retentionDays: number;
}

export interface Delivery {
  id: string;
  received_at: string;
  delivery_guid: string | null;
  event: string | null;
  action: string | null;
  github_app_id: string | null;
  github_app_row_id: string | null;
  app_name: string | null;
  outcome: 'processed' | 'ignored' | 'rejected' | 'error';
  reason: string;
  detail: string | null;
  repository: string | null;
  ref: string | null;
  commit_sha: string | null;
  review_run_id: string | null;
  review_status: string | null;
  review_gate: string | null;
  review_error: string | null;
  status_code: number;
  duration_ms: number | null;
  source_ip: string | null;
  user_agent: string | null;
  content_type: string | null;
  payload_bytes: number | null;
}

interface Page {
  items: Delivery[];
  hasMore: boolean;
}

const REASONS: Record<string, { label: string; hint?: string }> = {
  queued: { label: 'Análisis encolado' },
  repo_registered_queued: { label: 'Repo registrado y análisis encolado', hint: 'El repositorio no estaba sincronizado; se registró con los datos del propio evento.' },
  reused_review: { label: 'Ligado a un análisis existente' },
  ping: { label: 'Ping recibido', hint: 'La ruta del webhook, la red y el secret funcionan.' },
  installation_created: { label: 'Cuenta conectada' },
  installation_revoked: { label: 'App desinstalada' },
  installation_repos_updated: { label: 'Repos agregados' },
  clarification_received: {
    label: 'Respuesta a una pregunta de la IA',
    hint: 'Alguien comentó en el issue o PR de seguimiento y ese comentario se tomó como respuesta a una pregunta pendiente: la IA lo reevalúa.',
  },
  issue_synced: { label: 'Issue sincronizado' },
  ignored_branch: {
    label: 'Rama en la lista de omitidas',
    hint: 'Es lo más común al probar con la rama principal: por defecto se omite. Se cambia en la pestaña Configuración del repositorio.',
  },
  duplicate: { label: 'Commit ya analizado', hint: 'Lo mandó otra App instalada en el mismo repo, o GitHub reenvió la entrega.' },
  not_a_branch: { label: 'No es una rama (tag)' },
  branch_deleted: { label: 'Rama borrada' },
  no_installation: { label: 'Sin installation.id' },
  ignored_action: { label: 'Acción sin análisis' },
  ignored_event: { label: 'Evento no usado' },
  issue_is_pr: { label: 'Es un PR visto como issue' },
  repo_unregistered: { label: 'Repo sin registrar', hint: 'Usa "Sincronizar" en Cuentas GitHub.' },
  missing_app_id: { label: 'Falta el App ID', hint: 'La petición no trae X-GitHub-Hook-Installation-Target-ID: no viene de una GitHub App, o un proxy quita el header.' },
  unknown_app: {
    label: 'App ID desconocido',
    hint: 'GitHub envía eventos de una App cuyo App ID no está registrado aquí. Revisa que el App ID guardado sea el numérico de la App (no el Client ID ni el ID de instalación).',
  },
  bad_signature: {
    label: 'Firma inválida',
    hint: 'El webhook secret guardado en Cuentas GitHub no es el configurado en esa App en github.com. Usa "Corregir URL y secret en GitHub".',
  },
  no_raw_body: { label: 'Sin cuerpo' },
  exception: { label: 'Error al procesar' },
};

const OUTCOME_META: Record<Delivery['outcome'], { label: string; pill: string }> = {
  processed: { label: 'Procesado', pill: 'ok' },
  ignored: { label: 'Ignorado', pill: 'warn' },
  rejected: { label: 'Rechazado', pill: 'bad' },
  error: { label: 'Error', pill: 'bad' },
};

const EVENTS = ['push', 'pull_request', 'issues', 'issue_comment', 'installation', 'installation_repositories', 'ping'];

function timeAgo(iso: string | null): string {
  if (!iso) return 'nunca';
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 10) return 'hace instantes';
  if (sec < 60) return `hace ${sec} s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `hace ${min} min`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `hace ${hrs} h`;
  return `hace ${Math.floor(hrs / 24)} d`;
}

type Health = { tone: 'ok' | 'warn' | 'bad'; title: string; text: string };

function healthOf(app: AppSummary): Health {
  if (!app.last_received_at) {
    return {
      tone: 'bad',
      title: 'Nunca ha llegado nada',
      text: 'GitHub no ha entregado ningún evento de esta App a este servidor. Revisa en Cuentas GitHub → "Diagnosticar webhook": suele ser la URL del webhook, eventos sin suscribir o la App sin instalar en el repo.',
    };
  }
  const problemIsRecent =
    app.last_problem_at && (!app.last_processed_at || new Date(app.last_problem_at) > new Date(app.last_processed_at));
  if (problemIsRecent) {
    return {
      tone: 'bad',
      title: 'Llegan eventos, pero se rechazan',
      text: 'Mira el motivo en la tabla (firma inválida, App ID que no coincide…) y corrígelo en Cuentas GitHub.',
    };
  }
  if (app.total_24h === 0) {
    return { tone: 'warn', title: 'Sin actividad en 24 h', text: 'Si hiciste pushes y no aparecen, GitHub no los está entregando: usa "Diagnosticar webhook".' };
  }
  return { tone: 'ok', title: 'Recibiendo eventos', text: 'La ruta, el App ID y el secret funcionan.' };
}

function queryString(filters: { app: string; outcome: string; event: string }, before?: string): string {
  const params = new URLSearchParams({ limit: '50' });
  if (filters.app !== 'all') params.set('app', filters.app);
  if (filters.outcome !== 'all') params.set('outcome', filters.outcome);
  if (filters.event !== 'all') params.set('event', filters.event);
  if (before) params.set('before', before);
  return params.toString();
}

export function WebhookLog({ initialSummary, initialPage }: { initialSummary: Summary; initialPage: Page }) {
  const [summary, setSummary] = useState(initialSummary);
  const [items, setItems] = useState(initialPage.items);
  const [hasMore, setHasMore] = useState(initialPage.hasMore);
  const [filters, setFilters] = useState({ app: 'all', outcome: 'all', event: 'all' });
  const [live, setLive] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [, forceTick] = useState(0);
  const firstRender = useRef(true);

  const refresh = useCallback(
    async (opts: { reset?: boolean } = {}) => {
      try {
        const [page, sum] = await Promise.all([
          apiJson<Page>(`/api/webhook-log?${queryString(filters)}`),
          apiJson<Summary>('/api/webhook-log/summary'),
        ]);
        setSummary(sum);
        setHasMore(page.hasMore);
        setItems((prev) => {
          if (opts.reset || page.items.length === 0) return page.items;
          // Conserva lo que ya se cargó hacia atrás ("Cargar más") y reemplaza solo lo reciente.
          const oldest = page.items[page.items.length - 1].received_at;
          return [...page.items, ...prev.filter((d) => d.received_at < oldest)];
        });
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [filters],
  );

  // Cambiar un filtro recarga desde cero (el render inicial ya vino del servidor).
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    setLoading(true);
    refresh({ reset: true }).finally(() => setLoading(false));
  }, [filters, refresh]);

  useEffect(() => {
    if (!live) return;
    const poll = setInterval(() => refresh(), 10_000);
    return () => clearInterval(poll);
  }, [live, refresh]);

  // Mantiene vivos los "hace X min" sin pedir datos.
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  async function loadMore() {
    const before = items[items.length - 1]?.received_at;
    if (!before) return;
    setLoading(true);
    try {
      const page = await apiJson<Page>(`/api/webhook-log?${queryString(filters, before)}`);
      setItems((prev) => [...prev, ...page.items]);
      setHasMore(page.hasMore);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="hook-cards">
        {summary.apps.length === 0 && (
          <div className="card">
            <p style={{ margin: 0 }}>
              Todavía no hay ninguna GitHub App registrada. Agrégala en <Link href="/accounts">Cuentas GitHub</Link>.
            </p>
          </div>
        )}
        {summary.apps.map((app) => {
          const health = healthOf(app);
          return (
            <div key={app.app_row_id} className="card hook-card">
              <div className="hook-card-head">
                <strong>{app.name}</strong>
                <span className="chip">App ID {app.github_app_id}</span>
                <span className={`pill ${health.tone}`}>{health.title}</span>
              </div>
              <p className="hook-card-text">{health.text}</p>
              <dl className="hook-stats">
                <div>
                  <dt>Último evento</dt>
                  <dd>{timeAgo(app.last_received_at)}</dd>
                </div>
                <div>
                  <dt>Último push</dt>
                  <dd>{timeAgo(app.last_push_at)}</dd>
                </div>
                <div>
                  <dt>Últimas 24 h</dt>
                  <dd>
                    <span className="status-ok">{app.processed_24h}</span> procesados ·{' '}
                    <span className="status-warn">{app.ignored_24h}</span> ignorados ·{' '}
                    <span className="status-bad">{app.rejected_24h + app.error_24h}</span> con problema
                  </dd>
                </div>
              </dl>
              <button
                type="button"
                onClick={() => setFilters((f) => ({ ...f, app: app.app_row_id }))}
                className="hook-link-button"
              >
                Ver solo esta App
              </button>
            </div>
          );
        })}
        {summary.unknownApps.map((u) => (
          <div key={u.github_app_id ?? 'sin-header'} className="card hook-card hook-card-bad">
            <div className="hook-card-head">
              <strong>App no reconocida</strong>
              <span className="chip">{u.github_app_id ? `App ID ${u.github_app_id}` : 'sin header de App ID'}</span>
              <span className="pill bad">{u.total} rechazo(s) en 7 días</span>
            </div>
            <p className="hook-card-text">
              GitHub (o alguien) está enviando eventos que no coinciden con ninguna App registrada aquí. Último intento{' '}
              {timeAgo(u.last_received_at)}.{' '}
              {u.reasons.map((r) => REASONS[r]?.hint).filter(Boolean)[0] ?? ''}
            </p>
          </div>
        ))}
      </div>

      <div className="hook-toolbar">
        <label>
          App
          <select value={filters.app} onChange={(e) => setFilters((f) => ({ ...f, app: e.target.value }))}>
            <option value="all">Todas</option>
            {summary.apps.map((a) => (
              <option key={a.app_row_id} value={a.app_row_id}>
                {a.name}
              </option>
            ))}
            <option value="unknown">No reconocidas</option>
          </select>
        </label>
        <label>
          Resultado
          <select value={filters.outcome} onChange={(e) => setFilters((f) => ({ ...f, outcome: e.target.value }))}>
            <option value="all">Todos</option>
            <option value="processed">Procesados</option>
            <option value="ignored">Ignorados</option>
            <option value="rejected">Rechazados</option>
            <option value="error">Errores</option>
          </select>
        </label>
        <label>
          Evento
          <select value={filters.event} onChange={(e) => setFilters((f) => ({ ...f, event: e.target.value }))}>
            <option value="all">Todos</option>
            {EVENTS.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </label>
        <label className="hook-live">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
          En vivo (cada 10 s)
        </label>
        <button type="button" onClick={() => refresh({ reset: true })} disabled={loading}>
          Actualizar
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {items.length === 0 ? (
        <div className="card">
          <p style={{ margin: 0 }}>
            No hay entregas registradas con estos filtros. Si acabas de hacer un push y no aparece, GitHub no lo está
            enviando a este servidor: abre <Link href="/accounts">Cuentas GitHub</Link> y usa "Diagnosticar webhook" para ver
            qué dice GitHub de su lado.
          </p>
        </div>
      ) : (
        <div className="hook-table-wrap">
          <table className="hook-table">
            <thead>
              <tr>
                <th>Recibido</th>
                <th>App</th>
                <th>Evento</th>
                <th>Repositorio</th>
                <th>Resultado</th>
                <th>Motivo</th>
              </tr>
            </thead>
            <tbody>
              {items.map((d) => {
                const meta = OUTCOME_META[d.outcome];
                const reason = REASONS[d.reason];
                const open = expanded === d.id;
                return (
                  <Fragment key={d.id}>
                    <tr className="hook-row" onClick={() => setExpanded(open ? null : d.id)}>
                      <td title={new Date(d.received_at).toLocaleString()}>{timeAgo(d.received_at)}</td>
                      <td>{d.app_name ?? (d.github_app_id ? `ID ${d.github_app_id}` : '—')}</td>
                      <td>
                        <code>
                          {d.event ?? '?'}
                          {d.action ? `.${d.action}` : ''}
                        </code>
                      </td>
                      <td>
                        {d.repository ?? '—'}
                        {d.ref ? <span className="hook-sub"> · {d.ref.replace('refs/heads/', '')}</span> : null}
                        {d.commit_sha ? <span className="hook-sub"> · {d.commit_sha.slice(0, 7)}</span> : null}
                      </td>
                      <td>
                        <span className={`pill ${meta.pill}`}>{meta.label}</span>
                      </td>
                      <td>{reason?.label ?? d.reason}</td>
                    </tr>
                    {open && (
                      <tr className="hook-detail">
                        <td colSpan={6}>
                          {d.detail && <p style={{ margin: '0 0 0.5rem' }}>{d.detail}</p>}
                          {reason?.hint && <p className="hook-hint">{reason.hint}</p>}
                          <dl className="hook-meta">
                            <div><dt>Delivery ID</dt><dd><code>{d.delivery_guid ?? '—'}</code></dd></div>
                            <div><dt>HTTP</dt><dd>{d.status_code}{d.duration_ms != null ? ` · ${d.duration_ms} ms` : ''}</dd></div>
                            <div><dt>App ID recibido</dt><dd>{d.github_app_id ?? '—'}</dd></div>
                            <div><dt>Origen</dt><dd>{d.source_ip ?? '—'}</dd></div>
                            <div><dt>Content-Type</dt><dd>{d.content_type ?? '—'}{d.payload_bytes != null ? ` · ${d.payload_bytes} bytes` : ''}</dd></div>
                            <div><dt>User-Agent</dt><dd>{d.user_agent ?? '—'}</dd></div>
                            <div><dt>Fecha exacta</dt><dd>{new Date(d.received_at).toLocaleString()}</dd></div>
                          </dl>
                          {d.review_run_id && (
                            <p style={{ margin: '0.5rem 0 0' }}>
                              Análisis: <Link href={`/review-runs/${d.review_run_id}`}>ver detalle</Link> —{' '}
                              {d.review_status === 'completed'
                                ? `terminado${d.review_gate ? ` (${d.review_gate.replace('_', ' ')})` : ''}`
                                : d.review_status === 'failed'
                                  ? `falló: ${d.review_error ?? 'sin detalle'}`
                                  : 'en curso'}
                            </p>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {hasMore && (
        <p>
          <button type="button" onClick={loadMore} disabled={loading}>
            {loading ? 'Cargando…' : 'Cargar más'}
          </button>
        </p>
      )}
      <p className="hook-footnote">
        Se registra cada petición que llega al receptor de webhooks (aceptada o no) y se conserva {summary.retentionDays} días. No
        se guarda el contenido de los eventos. Lo que GitHub intentó enviar y nunca llegó a este servidor no puede aparecer
        aquí: para eso usa "Diagnosticar webhook" en <Link href="/accounts">Cuentas GitHub</Link>.
      </p>
    </>
  );
}
