'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

export type ReadinessStatus = 'ready' | 'attention' | 'blocked' | 'unknown';

export interface ReadinessItem {
  key: string;
  level: 'required' | 'recommended' | 'info';
  ok: boolean;
  title: string;
  message: string;
  fix?: string;
  link?: { label: string; href: string };
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

const STATUS_LABEL: Record<ReadinessStatus, string> = {
  ready: 'Apto para recibir pushes',
  attention: 'Apto, con recomendaciones',
  blocked: 'No recibirá pushes',
  unknown: 'No se pudo verificar',
};

export async function fetchReadiness(options: { repositoryId?: string; refresh?: boolean } = {}): Promise<RepositoryReadiness[]> {
  const params = new URLSearchParams();
  if (options.repositoryId) params.set('repositoryId', options.repositoryId);
  if (options.refresh) params.set('refresh', '1');
  const res = await fetch(`/api/repository-readiness${params.size ? `?${params}` : ''}`, { cache: 'no-store' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? `error ${res.status}`);
  }
  return res.json();
}

/** Línea corta para cada fila de la lista de repos: punto de color + estado (o lo que falta). */
export function ReadinessLine({ readiness, loading }: { readiness?: RepositoryReadiness; loading: boolean }) {
  if (!readiness) {
    return (
      <div className="ready-line ready-loading" aria-live="polite">
        <span className="ready-dot" />
        {loading ? 'Verificando configuración…' : 'Sin verificar'}
      </div>
    );
  }
  const failing = readiness.items.filter((i) => !i.ok && i.level === (readiness.status === 'blocked' ? 'required' : 'recommended')).length;
  const more = failing > 1 ? ` (+${failing - 1} más)` : '';
  const text =
    readiness.status === 'ready'
      ? STATUS_LABEL.ready
      : readiness.status === 'unknown'
        ? `${STATUS_LABEL.unknown}: ${readiness.summary}`
        : `${readiness.status === 'blocked' ? 'Falta' : 'Recomendado'}: ${readiness.summary}${more}`;
  return (
    <div className={`ready-line ready-${readiness.status}`} title={readiness.items.filter((i) => !i.ok && i.level !== 'info').map((i) => i.title).join(' · ') || STATUS_LABEL[readiness.status]}>
      <span className="ready-dot" />
      {text}
    </div>
  );
}

function itemIcon(item: ReadinessItem): { glyph: string; cls: string } {
  if (item.level === 'info') return { glyph: 'i', cls: 'ready-item-info' };
  if (item.ok) return { glyph: '✓', cls: 'ready-item-ok' };
  if (item.unknown) return { glyph: '?', cls: 'ready-item-unknown' };
  return item.level === 'required' ? { glyph: '✕', cls: 'ready-item-bad' } : { glyph: '!', cls: 'ready-item-warn' };
}

/** Checklist completo del repo: qué cumple y qué falta de lo que DevSentinel necesita para recibir
 * y analizar pushes, con el dato concreto y cómo corregirlo. */
export function RepoReadinessPanel({ repositoryId }: { repositoryId: string }) {
  const [readiness, setReadiness] = useState<RepositoryReadiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  const load = useCallback(
    async (refresh: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const [result] = await fetchReadiness({ repositoryId, refresh });
        setReadiness(result ?? null);
        // Abierto de entrada solo cuando hay algo que corregir.
        if (result && result.status !== 'ready') setOpen(true);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [repositoryId],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  return (
    <section className="ready-panel" aria-label="Aptitud para recibir pushes">
      <div className="ready-head">
        <ReadinessLine readiness={readiness ?? undefined} loading={loading} />
        <div className="ready-actions">
          {readiness && (
            <button type="button" className="ready-link" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
              {open ? 'Ocultar detalle' : 'Ver detalle'}
            </button>
          )}
          <button type="button" className="ready-link" onClick={() => void load(true)} disabled={loading}>
            {loading ? 'Verificando…' : 'Reverificar'}
          </button>
        </div>
      </div>
      {error && <p className="error-text">No se pudo verificar: {error}</p>}
      {readiness && open && (
        <ul className="ready-items">
          {readiness.items.map((item) => {
            const icon = itemIcon(item);
            return (
              <li key={item.key} className="ready-item">
                <span className={`ready-item-icon ${icon.cls}`} aria-hidden="true">
                  {icon.glyph}
                </span>
                <div className="ready-item-body">
                  <strong>{item.title}</strong>
                  {item.level === 'recommended' && <span className="ready-tag">recomendado</span>}
                  <p>{item.message}</p>
                  {!item.ok && item.fix && <p className="ready-fix">Qué hacer: {item.fix}</p>}
                  {!item.ok && item.link &&
                    (item.link.href.startsWith('/') ? (
                      <Link href={item.link.href}>{item.link.label} →</Link>
                    ) : (
                      <a href={item.link.href} target="_blank" rel="noreferrer noopener">
                        {item.link.label} ↗
                      </a>
                    ))}
                  {item.ok && item.link && item.level === 'info' && (
                    <Link href={item.link.href}>{item.link.label} →</Link>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {readiness && <p className="ready-foot">Verificado {new Date(readiness.checkedAt).toLocaleTimeString()}</p>}
    </section>
  );
}
