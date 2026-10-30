import type { Layer1Result } from './types';

export type GateDecisionLike = 'apto' | 'requiere_revision' | 'no_apto';

/** Lo que la capa 1 le impone al veredicto, sin importar lo que opine un modelo de IA. */
export interface AuditGuards {
  /** Algún escáner obligatorio y aplicable no terminó bien. */
  incomplete: boolean;
  missing: { tool: string; status: string; error: string | null }[];
  /** Secretos confirmados que son NUEVOS en este cambio (o de origen desconocido) y no tienen excepción aprobada. */
  newConfirmedSecrets: number;
}

export function guardsFromLayer1(result: Layer1Result): AuditGuards {
  return {
    incomplete: !result.coverage.complete,
    missing: result.coverage.missing,
    newConfirmedSecrets: result.findings.filter(
      (f) => f.category === 'secret' && f.baseline !== 'preexisting' && f.validation !== 'accepted_exception' && f.validation !== 'false_positive_suspected',
    ).length,
  };
}

/** Política determinista de la capa 1. Solo puede ENDURECER el veredicto, nunca aflojarlo:
 *  - un secreto nuevo y confirmado bloquea (si la configuración lo pide), aunque el modelo diga APTO;
 *  - una auditoría incompleta no puede ser APTO: queda en revisión humana. */
export function applyAuditGuards(
  decision: GateDecisionLike,
  guards: AuditGuards,
  config: { block_on_secret: boolean },
): { decision: GateDecisionLike; reasons: string[] } {
  const reasons: string[] = [];
  let out = decision;

  if (config.block_on_secret && guards.newConfirmedSecrets > 0) {
    reasons.push(`Se detectó ${guards.newConfirmedSecrets === 1 ? 'un secreto expuesto nuevo' : `${guards.newConfirmedSecrets} secretos expuestos nuevos`} (Gitleaks): bloquea el cambio sin importar el análisis del modelo.`);
    out = 'no_apto';
  }
  if (guards.incomplete) {
    const names = guards.missing.map((m) => `${m.tool} (${m.status})`).join(', ');
    reasons.push(`Auditoría incompleta: no terminaron los escáneres obligatorios ${names}. Un resultado sin ellos no puede aprobarse automáticamente.`);
    if (out === 'apto') out = 'requiere_revision';
  }
  return { decision: out, reasons };
}
