import type { Layer1Result } from './types';

export type GateDecisionLike = 'apto' | 'requiere_revision' | 'no_apto';

/** Lo que la capa 1 le impone al veredicto, sin importar lo que opine un modelo de IA. */
export interface AuditGuards {
  /** Algún escáner obligatorio y aplicable no terminó bien. */
  incomplete: boolean;
  missing: { tool: string; status: string; error: string | null }[];
  /** Secretos confirmados que son NUEVOS en este cambio (o de origen desconocido) y no tienen excepción aprobada. */
  newConfirmedSecrets: number;
  /** Una capa obligatoria se omitió por presupuesto y la política configurada es bloquear (no solo dejar incompleto). */
  budgetBlocked?: boolean;
}

/** Estado de la capa 2 en una auditoría, para las guardas: si estaba prevista y cómo terminó. */
export interface Layer2Guard {
  status: 'ok' | 'skipped_budget' | 'not_configured' | 'failed';
  reason: string | null;
  budgetPolicy: 'partial' | 'block' | null;
}

export function guardsFromLayer1(result: Layer1Result, layer2?: Layer2Guard | null): AuditGuards {
  const layer2Missing = layer2 && layer2.status !== 'ok' ? [{ tool: 'layer2', status: layer2.status, error: layer2.reason }] : [];
  return {
    incomplete: !result.coverage.complete || layer2Missing.length > 0,
    missing: [...result.coverage.missing, ...layer2Missing],
    budgetBlocked: layer2?.status === 'skipped_budget' && layer2.budgetPolicy === 'block',
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
    reasons.push(`Auditoría incompleta: no terminaron las verificaciones obligatorias ${names}. Un resultado sin ellas no puede aprobarse automáticamente.`);
    if (out === 'apto') out = 'requiere_revision';
  }
  if (guards.budgetBlocked) {
    reasons.push('Presupuesto de IA agotado y la política configurada es bloquear: el cambio queda NO APTO hasta que se renueve el presupuesto o un administrador lo revise.');
    out = 'no_apto';
  }
  return { decision: out, reasons };
}
