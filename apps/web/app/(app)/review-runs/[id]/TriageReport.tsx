export interface Layer2Summary {
  status: 'ok' | 'skipped_budget' | 'not_configured' | 'failed';
  reason: string | null;
  model: string | null;
  used_as_review: boolean;
  escalated_to: string | null;
  duration_ms: number;
  usage: { calls: number; promptTokens: number; completionTokens: number; costUsd: number; unpriced: number };
  change_tags: { tag: string; files: string[] }[];
  omitted_findings: number;
  groups: { title: string; refs: string[]; rationale: string }[];
  dismissals: { accepted: { ref: string; reason: string }[]; ignored: { ref: string; why: string }[] };
  rejected: { id: string; title: string; reason: string }[];
  suspected: { id: string; title: string; file_path: string }[];
  own_findings: number;
}

export interface Escalation {
  recommended: boolean;
  triggers: { type: string; detail: string }[];
}

export interface InvocationRow {
  purpose: string;
  model: string;
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number | null;
  unpriced: number;
  errors: number;
}

const STATUS: Record<Layer2Summary['status'], { label: string; cls: string }> = {
  ok: { label: 'ejecutada', cls: 'scan-status-ok' },
  skipped_budget: { label: 'omitida por presupuesto', cls: 'scan-status-failed' },
  not_configured: { label: 'sin agente asignado', cls: 'scan-status-failed' },
  failed: { label: 'falló', cls: 'scan-status-failed' },
};
const PURPOSE: Record<string, string> = { layer2: 'Capa 2 · triaje', layer3: 'Capa 3', review: 'Revisión general', reconsider: 'Reconsideración' };
const TRIGGER: Record<string, string> = {
  model_recommendation: 'recomendación del modelo',
  sensitive_change: 'cambio sensible',
  serious_finding: 'hallazgo grave confirmado',
  high_risk: 'riesgo alto',
  conflict: 'conflicto con un escáner',
};
const usd = (n: number) => `${n.toFixed(n < 1 ? 4 : 2)} USD`;

/** Capa 2 de la auditoría: qué hizo el triaje, si se escaló a la auditoría avanzada y cuánto costó cada llamada a un modelo. */
export function TriageReport({ layer2, escalation, invocations }: { layer2: Layer2Summary | null; escalation: Escalation | null; invocations: InvocationRow[] | null }) {
  const hasCost = invocations && invocations.length > 0;
  if (!layer2 && !hasCost) return null;
  const total = (invocations ?? []).reduce((n, r) => n + (r.cost_usd ?? 0), 0);

  return (
    <section className="scan" aria-label="Auditoría: capa 2 y costos">
      <h1>Auditoría — capa 2: triaje</h1>

      {layer2 && (
        <>
          <p>
            <span className={`scan-status ${STATUS[layer2.status].cls}`}>{STATUS[layer2.status].label}</span>{' '}
            {layer2.model && <code className="scan-mono">{layer2.model}</code>}
            {layer2.status === 'ok' && (
              <span className="scan-note">
                {' '}
                · {layer2.used_as_review ? 'esta capa produjo la revisión del commit' : `escalado a: ${layer2.escalated_to ?? 'revisión avanzada'}`} ·{' '}
                {Math.round(layer2.duration_ms / 1000)} s
              </span>
            )}
          </p>
          {layer2.reason && <p className="scan-banner scan-banner-bad" role="alert">{layer2.reason}</p>}

          {escalation && escalation.triggers.length > 0 && (
            <div className="scan-banner scan-banner-warn">
              <strong>Auditoría avanzada recomendada.</strong>
              <ul>
                {escalation.triggers.map((t, i) => (
                  <li key={i}>
                    {TRIGGER[t.type] ?? t.type}: {t.detail}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {layer2.change_tags.length > 0 && (
            <p className="scan-note">
              Tipo de cambio:{' '}
              {layer2.change_tags.map((t) => (
                <span key={t.tag} className="scan-tag" title={t.files.join('\n')}>{t.tag} ({t.files.length})</span>
              ))}
            </p>
          )}

          {layer2.groups.length > 0 && (
            <>
              <h2>Hallazgos agrupados</h2>
              <ul className="scan-list">
                {layer2.groups.map((g) => (
                  <li key={g.title} className="scan-item">
                    <strong>{g.title}</strong> <span className="scan-note">({g.refs.join(', ')})</span>
                    <p>{g.rationale}</p>
                  </li>
                ))}
              </ul>
            </>
          )}

          {layer2.dismissals.accepted.length > 0 && (
            <>
              <h2>Posibles falsos positivos</h2>
              <ul className="scan-list">
                {layer2.dismissals.accepted.map((d) => (
                  <li key={d.ref} className="scan-item"><strong>{d.ref}</strong> — {d.reason}</li>
                ))}
              </ul>
            </>
          )}
          {layer2.dismissals.ignored.length > 0 && (
            <p className="scan-note">
              Descartes del modelo que la aplicación NO aceptó: {layer2.dismissals.ignored.map((d) => `${d.ref} (${d.why})`).join('; ')}.
            </p>
          )}
          {layer2.rejected.length > 0 && (
            <div className="scan-banner scan-banner-warn">
              <strong>{layer2.rejected.length} hallazgo(s) del modelo se descartaron por no poder comprobarse en el repositorio:</strong>
              <ul>
                {layer2.rejected.map((r) => (
                  <li key={r.id}>{r.title} — {r.reason}</li>
                ))}
              </ul>
            </div>
          )}
          {layer2.omitted_findings > 0 && (
            <p className="scan-note">{layer2.omitted_findings} hallazgo(s) de los escáneres no entraron al triaje por el tope de contexto.</p>
          )}
        </>
      )}

      {hasCost && (
        <div className="scan-table-wrap">
          <table className="scan-table">
            <caption className="scan-note">Consumo de IA de esta auditoría (costo estimado con la tarifa vigente)</caption>
            <thead>
              <tr><th>Propósito</th><th>Modelo</th><th>Llamadas</th><th>Tokens (entrada / salida)</th><th>Costo</th></tr>
            </thead>
            <tbody>
              {invocations!.map((r) => (
                <tr key={`${r.purpose}-${r.model}`}>
                  <td>{PURPOSE[r.purpose] ?? r.purpose}</td>
                  <td className="scan-mono">{r.model}</td>
                  <td>{r.calls}{r.errors > 0 ? ` (${r.errors} con error)` : ''}</td>
                  <td>{r.prompt_tokens.toLocaleString('es')} / {r.completion_tokens.toLocaleString('es')}</td>
                  <td>{r.cost_usd === null ? 'sin tarifa' : usd(r.cost_usd)}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={4}><strong>Total</strong></td>
                <td><strong>{usd(total)}</strong></td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
