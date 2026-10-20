'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

interface ContextRun {
  id: string;
  mode: 'fill' | 'replace';
  status: 'queued' | 'running' | 'done' | 'failed';
  sources: string[];
  applied_fields: string[];
  error_message: string | null;
  created_at: string;
  finished_at: string | null;
}

const FIELD_LABEL: Record<string, string> = {
  language: 'lenguaje',
  framework: 'framework',
  framework_version: 'versión',
  runtime: 'runtime',
  database: 'base de datos',
  architecture_style: 'arquitectura',
  testing_strategy: 'testing',
  notes: 'notas',
  migrations_policy: 'migraciones',
  compatibility_notes: 'compatibilidad',
  mandatory_rules: 'reglas obligatorias',
  security_rules: 'reglas de seguridad',
  conventions: 'convenciones',
};

const POLL_MS = 2500;
const GIVE_UP_AFTER_MS = 5 * 60_000;

const isActive = (run: ContextRun | null) => run?.status === 'queued' || run?.status === 'running';

/** "Generar contexto": el worker lee el README, CLAUDE.md / AGENTS.md y los archivos de dependencias
 * del repo y arma el perfil con la IA. Con un perfil que alguien ya configuró solo completa lo que
 * esté vacío; reemplazarlo todo es una acción aparte que pide confirmación. */
export function GenerateContextButton({ repositoryId, curated }: { repositoryId: string; curated: boolean }) {
  const router = useRouter();
  const [run, setRun] = useState<ContextRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const wasActive = useRef(false);
  const startedAt = useRef<number | null>(null);

  const base = `/api/dashboard/repositories/${repositoryId}/project-profile`;

  const refreshRun = useCallback(async () => {
    const res = await fetch(`${base}/generation`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`error ${res.status}`);
    const text = await res.text();
    setRun(text ? (JSON.parse(text) as ContextRun | null) : null);
  }, [base]);

  useEffect(() => {
    refreshRun().catch(() => undefined);
  }, [refreshRun]);

  // Mientras la corrida esté en cola o en curso, consulta su estado cada pocos segundos.
  useEffect(() => {
    if (!isActive(run)) return;
    startedAt.current ??= Date.now();
    const timer = setInterval(() => {
      if (startedAt.current && Date.now() - startedAt.current > GIVE_UP_AFTER_MS) {
        clearInterval(timer);
        setTimedOut(true);
        return;
      }
      refreshRun().catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [run, refreshRun]);

  // Al terminar bien, recarga la página para que el formulario muestre el perfil nuevo.
  useEffect(() => {
    const active = isActive(run);
    if (wasActive.current && !active && run?.status === 'done') router.refresh();
    if (!active) startedAt.current = null;
    wasActive.current = active;
  }, [run, router]);

  async function start(replace: boolean) {
    if (replace && !window.confirm('Se reemplazarán TODOS los campos del perfil por lo que se detecte en el repositorio, incluidos los que escribiste a mano. ¿Continuar?')) {
      return;
    }
    setStarting(true);
    setError(null);
    setTimedOut(false);
    try {
      const res = await fetch(`${base}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replace }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? `error ${res.status}`);
      }
      startedAt.current = Date.now();
      setRun((await res.json()) as ContextRun);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStarting(false);
    }
  }

  const active = isActive(run);
  const busy = starting || (active && !timedOut);

  return (
    <section className="ctx-card" aria-label="Generar contexto">
      <div className="ctx-head">
        <div>
          <h3>Generar contexto del proyecto</h3>
          <p>
            Lee el README, CLAUDE.md / AGENTS.md, los archivos de dependencias (package.json, composer.json…) y la estructura de
            carpetas de la rama principal, y con eso completa el perfil: lenguaje, framework, base de datos, arquitectura y
            reglas.{' '}
            {curated
              ? 'Este perfil ya fue configurado a mano: solo se completarán los campos vacíos.'
              : 'Queda como borrador editable.'}
          </p>
        </div>
        <div className="ctx-actions">
          <button type="button" onClick={() => void start(false)} disabled={busy}>
            {busy ? 'Generando…' : curated ? 'Completar con IA' : 'Generar contexto'}
          </button>
          {curated && (
            <button type="button" className="ready-link" onClick={() => void start(true)} disabled={busy}>
              Reemplazar todo con lo detectado
            </button>
          )}
        </div>
      </div>

      {active && !timedOut && (
        <p className="ctx-status" aria-live="polite">
          {run?.status === 'queued' ? 'En cola…' : 'Leyendo el repositorio y analizándolo con la IA…'} suele tardar menos de un
          minuto.
        </p>
      )}
      {timedOut && (
        <p className="error-text">Está tardando más de lo normal. Revisa que el worker esté en marcha y vuelve a intentar.</p>
      )}
      {run?.status === 'done' && (
        <p className="status-ok ctx-status">
          Listo: usó {run.sources.join(', ')}.{' '}
          {run.applied_fields.length > 0
            ? `Se completaron: ${run.applied_fields.map((f) => FIELD_LABEL[f] ?? f).join(', ')}.`
            : 'No había nada nuevo para completar.'}
        </p>
      )}
      {run?.status === 'failed' && <p className="error-text">No se pudo generar: {run.error_message ?? 'error desconocido'}</p>}
      {error && <p className="error-text">{error}</p>}
    </section>
  );
}
