'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MergeDialog } from '../../../components/MergeDialog';

async function postJson(path: string, body?: unknown): Promise<any> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? `error ${res.status}`);
  return data;
}

export interface LinkedPullRequest {
  id: string;
  number: number;
  status: string;
  url: string | null;
}

/** Acciones de Pull Request de un push: crear, y mergear en el momento (con ventana de confirmación) sin salir de la
 * lista. Si el push ya tiene PR, muestra su estado y, estando abierto, el botón "Mergear ahora". */
export function PullRequestQuickActions({
  repositoryId,
  reviewRunId,
  canCreate,
  initialPullRequest,
}: {
  repositoryId: string;
  reviewRunId: string;
  /** El análisis de este push permite abrir un PR (APTO, o riesgo medio con score bajo). */
  canCreate: boolean;
  initialPullRequest: LinkedPullRequest | null;
}) {
  const router = useRouter();
  const [pr, setPr] = useState<LinkedPullRequest | null>(initialPullRequest);
  const [loading, setLoading] = useState<'create' | 'create-merge' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const merged = useRef(false);

  async function create(thenMerge: boolean) {
    if (!window.confirm('¿Crear (o reutilizar) el Pull Request de este commit hacia la rama destino configurada?')) return;
    setLoading(thenMerge ? 'create-merge' : 'create');
    setError(null);
    try {
      const row = await postJson('/pull-requests/from-push', { repositoryId, reviewRunId });
      setPr({ id: row.id, number: row.github_pr_number, status: row.status, url: null });
      if (thenMerge) setDialogOpen(true);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="pr-quick">
      {!pr && canCreate && (
        <div className="card-row">
          <button onClick={() => void create(false)} disabled={loading !== null}>
            {loading === 'create' ? 'Creando…' : 'Crear Pull Request'}
          </button>
          <button onClick={() => void create(true)} disabled={loading !== null} title="Crea el PR y abre la confirmación de merge">
            {loading === 'create-merge' ? 'Creando…' : 'Crear y mergear'}
          </button>
        </div>
      )}

      {pr && (
        <div className="card-row">
          <span>
            {pr.url ? (
              <a href={pr.url} target="_blank" rel="noreferrer noopener">PR #{pr.number} ↗</a>
            ) : (
              <>PR #{pr.number}</>
            )}{' '}
            {pr.status === 'merged' ? <span className="status-ok">✓ mergeado</span> : pr.status === 'open' ? <span className="status-warn">abierto</span> : <span>{pr.status}</span>}
          </span>
          {pr.status === 'open' && <button onClick={() => setDialogOpen(true)}>Mergear ahora</button>}
        </div>
      )}

      {pr && (
        <MergeDialog
          pullRequestId={pr.id}
          open={dialogOpen}
          onClose={() => {
            setDialogOpen(false);
            // La lista se actualiza al cerrar, para que la persona alcance a ver la confirmación.
            if (merged.current) router.refresh();
          }}
          onMerged={() => {
            merged.current = true;
            setPr((p) => (p ? { ...p, status: 'merged' } : p));
          }}
        />
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

/** Botón "Mergear" de la pestaña Pull requests: abre la misma ventana de confirmación. */
export function MergePullRequestButton({ pullRequestId }: { pullRequestId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const merged = useRef(false);
  return (
    <div>
      <button onClick={() => setOpen(true)}>Mergear</button>
      {/* Al mergear, la fila deja de ofrecer este botón: la tabla se refresca al CERRAR la ventana para que se vea la confirmación. */}
      <MergeDialog
        pullRequestId={pullRequestId}
        open={open}
        onClose={() => {
          setOpen(false);
          if (merged.current) router.refresh();
        }}
        onMerged={() => {
          merged.current = true;
        }}
      />
    </div>
  );
}
