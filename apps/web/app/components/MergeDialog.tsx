'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { GateBadge } from '../GateBadge';

interface MergeSummary {
  number: number;
  title: string;
  url: string;
  head: string;
  base: string;
  verdict: 'apto' | 'requiere_revision' | 'no_apto' | null;
  score: number | null;
  risk: 'low' | 'medium' | 'high' | null;
  checks: { name: string; status: string; conclusion: string | null }[];
}

interface MergeValidation {
  canMerge: boolean;
  reasons: string[];
  pending: boolean;
  summary: MergeSummary;
}

type Phase = 'validating' | 'ready' | 'blocked' | 'merging' | 'merged' | 'error';

async function post<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`, { method: 'POST', cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(Array.isArray(data.message) ? data.message.join(', ') : (data.message ?? `error ${res.status}`));
  return data as T;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const checkIcon = (c: { status: string; conclusion: string | null }) =>
  c.status !== 'completed' ? '…' : c.conclusion === 'success' || c.conclusion === 'neutral' || c.conclusion === 'skipped' ? '✓' : '✕';

/** Ventana de confirmación del merge: valida el PR en el momento (análisis, conflictos, checks), muestra el resumen y
 * solo deja confirmar si todo está en regla. Recién creado, GitHub tarda unos segundos en calcular si es mergeable:
 * la ventana espera ese cálculo en vez de mostrar un falso error. */
export function MergeDialog({
  pullRequestId,
  open,
  onClose,
  onMerged,
}: {
  pullRequestId: string;
  open: boolean;
  onClose: () => void;
  onMerged?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [phase, setPhase] = useState<Phase>('validating');
  const [validation, setValidation] = useState<MergeValidation | null>(null);
  const [error, setError] = useState<string | null>(null);

  const validate = useCallback(async () => {
    setPhase('validating');
    setError(null);
    try {
      let result = await post<MergeValidation>(`/pull-requests/${pullRequestId}/validate-merge`);
      // El servidor ya espera ~9 s; si GitHub sigue calculando, se reintenta un par de veces más.
      for (let i = 0; i < 2 && result.pending; i++) {
        await sleep(2500);
        result = await post<MergeValidation>(`/pull-requests/${pullRequestId}/validate-merge`);
      }
      setValidation(result);
      setPhase(result.canMerge ? 'ready' : 'blocked');
    } catch (err) {
      setError((err as Error).message);
      setPhase('error');
    }
  }, [pullRequestId]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      void validate();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, validate]);

  async function confirm() {
    setPhase('merging');
    setError(null);
    try {
      const result = await post<{ merged: boolean }>(`/pull-requests/${pullRequestId}/merge`);
      if (!result.merged) throw new Error('GitHub no completó el merge');
      setPhase('merged');
      onMerged?.();
    } catch (err) {
      setError((err as Error).message);
      setPhase('error');
    }
  }

  const s = validation?.summary;
  const busy = phase === 'validating' || phase === 'merging';

  return (
    <dialog ref={ref} className="merge-dialog" onClose={onClose} onCancel={(e) => busy && e.preventDefault()} aria-labelledby={titleId}>
      <h3 id={titleId}>Mergear Pull Request</h3>

      {phase === 'validating' && (
        <p role="status" aria-live="polite">
          Validando el PR (análisis, conflictos y checks)… si acaba de crearse, GitHub tarda unos segundos en calcular si se puede mergear.
        </p>
      )}

      {s && phase !== 'validating' && (
        <>
          <p className="merge-pr">
            <a href={s.url} target="_blank" rel="noreferrer noopener">
              #{s.number} {s.title} ↗
            </a>
          </p>
          <p className="merge-branches">
            <code>{s.head}</code> → <code>{s.base}</code>
          </p>
          <p>
            Análisis de DevSentinel: <GateBadge decision={s.verdict} />
            {s.score !== null && <> · score {s.score}</>}
            {s.risk && <> · riesgo {s.risk}</>}
          </p>
          {s.checks.length > 0 && (
            <ul className="merge-checks">
              {s.checks.map((c) => (
                <li key={c.name} className={checkIcon(c) === '✕' ? 'merge-check-bad' : ''}>
                  <span aria-hidden="true">{checkIcon(c)}</span> {c.name}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {phase === 'ready' && <p className="status-ok">✓ Todo en regla para mergear.</p>}
      {phase === 'blocked' && validation && (
        <div role="alert">
          <p className="status-bad">No se puede mergear todavía:</p>
          <ul className="merge-reasons">
            {validation.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      {phase === 'merging' && <p role="status">Mergeando…</p>}
      {phase === 'merged' && <p className="status-ok" role="status">✓ Pull Request mergeado.</p>}
      {phase === 'error' && error && <p className="error-text" role="alert">{error}</p>}

      <div className="merge-actions">
        {phase === 'merged' ? (
          <button type="button" onClick={onClose}>Cerrar</button>
        ) : (
          <>
            <button type="button" className="ready-link" onClick={onClose} disabled={phase === 'merging'}>
              Cancelar
            </button>
            {(phase === 'blocked' || phase === 'error') && (
              <button type="button" className="ready-link" onClick={() => void validate()}>
                Volver a validar
              </button>
            )}
            <button type="button" onClick={() => void confirm()} disabled={phase !== 'ready'}>
              {phase === 'merging' ? 'Mergeando…' : 'Confirmar merge'}
            </button>
          </>
        )}
      </div>
    </dialog>
  );
}
