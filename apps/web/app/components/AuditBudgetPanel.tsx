'use client';

import { useState, type FormEvent } from 'react';

export interface AuditBudgetData {
  budget: { monthlyUsd: number; perAuditUsd: number; policy: 'partial' | 'block' };
  month: {
    spentUsd: number;
    remainingUsd: number;
    percentUsed: number;
    unpricedCalls: number;
    breakdown: { model: string; purpose: string; calls: number; promptTokens: number; completionTokens: number; costUsd: number; unpricedCalls: number }[];
  };
  prices: {
    model_key: string;
    inference: string;
    context_tier: string;
    input_per_mtok: string;
    cache_read_per_mtok: string;
    output_per_mtok: string;
    effective_from: string;
  }[];
}

const PURPOSE_LABEL: Record<string, string> = {
  layer2: 'Capa 2 · triaje',
  layer3: 'Capa 3 · avanzada',
  review: 'Revisión general',
  reconsider: 'Reconsideración',
  clarification: 'Aclaraciones',
  issue_reply: 'Respuestas de issues',
  project_profile: 'Perfil del proyecto',
};

const usd = (n: number) => `${n.toFixed(n < 1 ? 4 : 2)} USD`;

/** Presupuesto de IA de la auditoría por capas: tope mensual, tope por auditoría, qué pasa al agotarlo y lo gastado en el mes. */
export function AuditBudgetPanel({ initial }: { initial: AuditBudgetData }) {
  const [data, setData] = useState(initial);
  const [monthly, setMonthly] = useState(String(initial.budget.monthlyUsd));
  const [perAudit, setPerAudit] = useState(String(initial.budget.perAuditUsd));
  const [policy, setPolicy] = useState(initial.budget.policy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch('/api/system-settings/audit-budget', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ monthlyUsd: monthly, perAuditUsd: perAudit, policy }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(Array.isArray(json.message) ? json.message.join(', ') : (json.message ?? `error ${res.status}`));
      setData(json as AuditBudgetData);
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const { month } = data;
  const level = month.percentUsed >= 100 ? 'bad' : month.percentUsed >= 80 ? 'warn' : 'ok';

  return (
    <section className="agents-panel budget-panel" aria-labelledby="budget-title">
      <h2 id="budget-title">Presupuesto de IA</h2>
      <p className="agents-lead">
        Tope de gasto de los modelos de la auditoría por capas (una sola cuenta para todas las organizaciones). El costo se calcula con las
        tarifas de la tabla de abajo; antes de cada llamada se comprueba que no se pase del tope.
      </p>

      <div className="budget-meter" role="img" aria-label={`Gastado ${month.percentUsed}% del presupuesto mensual`}>
        <div className={`budget-meter-fill budget-${level}`} style={{ width: `${Math.max(2, month.percentUsed)}%` }} />
      </div>
      <p className="budget-figures">
        Gastado este mes: <strong>{usd(month.spentUsd)}</strong> de {usd(data.budget.monthlyUsd)} ({month.percentUsed}%) · quedan{' '}
        <strong>{usd(month.remainingUsd)}</strong>
        {month.unpricedCalls > 0 && (
          <span className="status-warn"> · {month.unpricedCalls} llamada(s) sin tarifa cargada no se contabilizan</span>
        )}
      </p>

      <form className="budget-form" onSubmit={save}>
        <label>
          Tope mensual (USD)
          <input id="budget-monthly" inputMode="decimal" value={monthly} onChange={(e) => setMonthly(e.target.value)} required />
        </label>
        <label>
          Tope por auditoría (USD)
          <input id="budget-per-audit" inputMode="decimal" value={perAudit} onChange={(e) => setPerAudit(e.target.value)} required />
        </label>
        <fieldset className="depth-picker">
          <legend>Si no alcanza el presupuesto</legend>
          <label className="depth-option">
            <input type="radio" name="budget-policy" checked={policy === 'partial'} onChange={() => setPolicy('partial')} />
            <span>
              <strong>Revisión parcial</strong>
              <small>La capa que no cabe se omite, la auditoría queda <em>incompleta</em> y nunca sale APTO (queda en revisión humana).</small>
            </span>
          </label>
          <label className="depth-option">
            <input type="radio" name="budget-policy" checked={policy === 'block'} onChange={() => setPolicy('block')} />
            <span>
              <strong>Bloquear</strong>
              <small>Igual que la anterior, y además el commit queda NO APTO hasta que se renueve el presupuesto.</small>
            </span>
          </label>
        </fieldset>
        <div>
          <button type="submit" disabled={busy}>{busy ? 'Guardando…' : 'Guardar presupuesto'}</button>
          {saved && <span className="status-ok" style={{ marginLeft: '0.5em' }}>Guardado</span>}
        </div>
        {error && <p className="error-text" role="alert">{error}</p>}
      </form>

      {month.breakdown.length > 0 && (
        <div className="scan-table-wrap">
          <table className="scan-table">
            <caption className="scan-note">Gasto del mes por propósito y modelo</caption>
            <thead>
              <tr><th>Propósito</th><th>Modelo</th><th>Llamadas</th><th>Tokens (entrada / salida)</th><th>Costo</th></tr>
            </thead>
            <tbody>
              {month.breakdown.map((r) => (
                <tr key={`${r.purpose}-${r.model}`}>
                  <td>{PURPOSE_LABEL[r.purpose] ?? r.purpose}</td>
                  <td className="scan-mono">{r.model}</td>
                  <td>{r.calls}</td>
                  <td>{r.promptTokens.toLocaleString('es')} / {r.completionTokens.toLocaleString('es')}</td>
                  <td>{r.unpricedCalls === r.calls ? 'sin tarifa' : usd(r.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <details className="budget-prices">
        <summary>Tarifas vigentes (USD por millón de tokens)</summary>
        <p className="scan-note">
          Vienen de las fichas de modelo de Amazon Bedrock y se guardan en la base (<code>model_prices</code>), no en el código. Verifícalas
          contra la página de precios de Bedrock y agrega una fila nueva cuando cambien.
        </p>
        <div className="scan-table-wrap">
          <table className="scan-table">
            <thead>
              <tr><th>Modelo</th><th>Inferencia</th><th>Contexto</th><th>Entrada</th><th>Entrada en caché</th><th>Salida</th></tr>
            </thead>
            <tbody>
              {data.prices.map((p) => (
                <tr key={`${p.model_key}-${p.inference}-${p.context_tier}`}>
                  <td className="scan-mono">{p.model_key}</td>
                  <td>{p.inference}</td>
                  <td>{p.context_tier === 'short' ? '≤ 272K' : '> 272K'}</td>
                  <td>{Number(p.input_per_mtok)}</td>
                  <td>{Number(p.cache_read_per_mtok)}</td>
                  <td>{Number(p.output_per_mtok)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
