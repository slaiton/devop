import type { TriageResult } from '@devsentinel/llm-port';

const RESULT_RANK = { APTO: 0, REQUIERE_REVISION: 1, NO_APTO: 2 } as const;
const RISK_RANK = { low: 0, medium: 1, high: 2 } as const;
const unique = <T>(items: T[], max: number) => [...new Set(items)].slice(0, max);

/** Reduce: junta los triajes de varios fragmentos de un cambio grande en UNO solo. Siempre toma lo más estricto (el peor veredicto, la menor
 * calidad, el mayor riesgo, escalar si cualquiera lo pide), nunca lo más benigno: un fragmento tranquilo no puede tapar a otro con problemas. */
export function mergeTriage(parts: TriageResult[]): TriageResult {
  if (parts.length === 1) return parts[0];
  const worst = parts.reduce((w, p) => (RESULT_RANK[p.resultado] > RESULT_RANK[w.resultado] ? p : w));
  const riskiest = parts.reduce((w, p) => (RISK_RANK[p.risk_level] > RISK_RANK[w.risk_level] ? p : w));

  const groups = new Map<string, { title: string; finding_refs: string[]; rationale: string }>();
  for (const p of parts) {
    for (const g of p.groups) {
      const key = g.title.trim().toLowerCase();
      const existing = groups.get(key);
      if (existing) existing.finding_refs = unique([...existing.finding_refs, ...g.finding_refs], 200);
      else groups.set(key, { ...g, finding_refs: [...g.finding_refs] });
    }
  }
  const dismissed = new Map<string, { ref: string; reason: string }>();
  for (const p of parts) for (const d of p.dismissed) if (!dismissed.has(d.ref)) dismissed.set(d.ref, d);

  const summary = parts.map((p, i) => `Parte ${i + 1}/${parts.length}: ${p.resumen_ejecutivo.replace(/\s+/g, ' ').trim()}`).join('\n');
  const justification = parts.map((p, i) => `Parte ${i + 1}/${parts.length}: ${p.justificacion_final.replace(/\s+/g, ' ').trim()}`).join('\n');

  return {
    resultado: worst.resultado,
    quality_score: Math.min(...parts.map((p) => p.quality_score)),
    risk_level: riskiest.risk_level,
    resumen_ejecutivo: `El cambio es grande y se analizó en ${parts.length} partes.\n${summary.slice(0, 3500)}`,
    justificacion_final: justification.slice(0, 2500),
    comparacion_commits_previos: parts.map((p) => p.comparacion_commits_previos).find((c) => c && !/sin relación/i.test(c)) ?? parts[0].comparacion_commits_previos,
    recomendaciones: unique(parts.flatMap((p) => p.recomendaciones), 20),
    tests_recomendados: unique(parts.flatMap((p) => p.tests_recomendados), 20),
    // los ids se prefijan por parte para que no se repitan entre fragmentos
    findings: parts.flatMap((p, i) => p.findings.map((f) => ({ ...f, id: `P${i + 1}-${f.id}` }))),
    groups: [...groups.values()],
    dismissed: [...dismissed.values()],
    escalation: { recommended: parts.some((p) => p.escalation.recommended), reasons: unique(parts.flatMap((p) => p.escalation.reasons), 8) },
  };
}
