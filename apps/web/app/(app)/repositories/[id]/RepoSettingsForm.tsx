'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export function RepoSettingsForm({
  repositoryId,
  promotionSourceBranch,
  promotionTargetBranch,
  autoCreatePrOnPush,
  notifyAuthorOnPush,
  autoMergeOnGreen,
  ignoredPushBranches,
  analysisDepth,
  auditLayer1,
}: {
  repositoryId: string;
  promotionSourceBranch: string;
  promotionTargetBranch: string;
  autoCreatePrOnPush: boolean;
  notifyAuthorOnPush: boolean;
  autoMergeOnGreen: boolean;
  ignoredPushBranches: string[];
  analysisDepth: 'standard' | 'deep';
  auditLayer1: boolean;
}) {
  const router = useRouter();
  const [sourceBranch, setSourceBranch] = useState(promotionSourceBranch);
  const [targetBranch, setTargetBranch] = useState(promotionTargetBranch);
  const [autoCreatePr, setAutoCreatePr] = useState(autoCreatePrOnPush);
  const [notifyAuthor, setNotifyAuthor] = useState(notifyAuthorOnPush);
  const [autoMerge, setAutoMerge] = useState(autoMergeOnGreen);
  const [ignoredBranches, setIgnoredBranches] = useState(ignoredPushBranches.join(', '));
  const [depth, setDepth] = useState<'standard' | 'deep'>(analysisDepth);
  const [layer1, setLayer1] = useState(auditLayer1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/dashboard/repositories/${repositoryId}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          promotionSourceBranch: sourceBranch.trim(),
          promotionTargetBranch: targetBranch.trim(),
          autoCreatePrOnPush: autoCreatePr,
          notifyAuthorOnPush: notifyAuthor,
          autoMergeOnGreen: autoMerge,
          analysisDepth: depth,
          auditLayer1: layer1,
          ignoredPushBranches: ignoredBranches
            .split(',')
            .map((b) => b.trim())
            .filter(Boolean),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? `error ${res.status}`);
      }
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <p style={{ color: 'var(--ink-muted)' }}>
        Se analiza cualquier push a cualquier rama del repositorio, excepto las ramas listadas abajo.
      </p>
      <fieldset className="depth-picker">
        <legend>Profundidad del análisis</legend>
        <label className="depth-option">
          <input type="radio" name="analysis-depth" checked={depth === 'standard'} onChange={() => setDepth('standard')} />
          <span>
            <strong>Estándar</strong>
            <small>Una sola pasada sobre el diff, el perfil del proyecto y los últimos commits. Rápido y barato.</small>
          </span>
        </label>
        <label className="depth-option">
          <input type="radio" name="analysis-depth" checked={depth === 'deep'} onChange={() => setDepth('deep')} />
          <span>
            <strong>Profundo</strong>
            <small>
              La IA investiga antes de opinar: lee archivos completos, busca dónde se usa lo que cambió, revisa el historial de cada
              archivo y el contexto del Pull Request. Tarda más y gasta más tokens; si el modelo no soporta herramientas, se analiza en
              modo estándar y se avisa.
            </small>
          </span>
        </label>
      </fieldset>
      <fieldset className="depth-picker">
        <legend>Auditoría por capas</legend>
        <label className="depth-option">
          <input type="checkbox" checked={layer1} onChange={(e) => setLayer1(e.target.checked)} />
          <span>
            <strong>Capa 1: escáneres deterministas</strong>
            <small>
              Antes de la IA corren, aislados y con versiones fijas, solo los escáneres que aplican a este repo: Gitleaks (secretos), Semgrep
              (código), Trivy (dependencias), Checkov (Terraform/IaC) y Hadolint (Dockerfile). Un secreto nuevo bloquea siempre, y si algún
              escáner obligatorio no termina bien la auditoría queda <em>incompleta</em> y nunca sale APTO.
            </small>
          </span>
        </label>
      </fieldset>
      <p>
        <label>
          Ramas a omitir (separadas por coma):
          <input
            value={ignoredBranches}
            onChange={(e) => setIgnoredBranches(e.target.value)}
            placeholder="main, master, develop"
          />
        </label>
      </p>
      <p>
        <label>
          Rama origen para Pull Request: <input value={sourceBranch} onChange={(e) => setSourceBranch(e.target.value)} />
        </label>
      </p>
      <p>
        <label>
          Rama destino para Pull Request: <input value={targetBranch} onChange={(e) => setTargetBranch(e.target.value)} />
        </label>
      </p>
      <p>
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: '0.4rem' }}>
          <input type="checkbox" checked={autoCreatePr} onChange={(e) => setAutoCreatePr(e.target.checked)} style={{ minWidth: 0 }} />
          Crear Pull Request automáticamente cuando un push a la rama origen salga APTO
        </label>
      </p>
      <p>
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: '0.4rem' }}>
          <input type="checkbox" checked={notifyAuthor} onChange={(e) => setNotifyAuthor(e.target.checked)} style={{ minWidth: 0 }} />
          Notificar por correo al autor de cada push analizado
        </label>
      </p>
      <p>
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: '0.4rem' }}>
          <input type="checkbox" checked={autoMerge} onChange={(e) => setAutoMerge(e.target.checked)} style={{ minWidth: 0 }} />
          Mergear automáticamente el Pull Request de promoción cuando un push a la rama origen salga APTO (score verde) — sin revisión
          humana
        </label>
      </p>
      <button type="submit" disabled={loading}>
        {loading ? 'Guardando…' : 'Guardar'}
      </button>
      {saved && <span className="status-ok" style={{ marginLeft: '0.5em' }}>Guardado</span>}
      {error && <p className="error-text">{error}</p>}
    </form>
  );
}
