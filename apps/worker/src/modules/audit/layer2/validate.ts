import { readFile } from 'fs/promises';
import { join } from 'path';
import type { Finding, TriageResult } from '@devsentinel/llm-port';
import { redactSecrets } from '../../../common/redact';
import type { NormalizedFinding, ValidationStatus } from '../types';

/** La respuesta de un modelo NUNCA se acepta tal cual: cada referencia debe existir y cada cita de evidencia se busca en el
 * repositorio real. Lo que no se pueda comprobar se descarta y queda registrado con su motivo (no se pierde la trazabilidad). */

export interface RejectedItem {
  id: string;
  title: string;
  reason: string;
}

export interface TriageAnnotation {
  fingerprint: string;
  ref: string;
  group: string | null;
  /** true = el modelo lo descartó como falso positivo y la aplicación lo aceptó. */
  dismissed: boolean;
  note: string | null;
  /** Posición en la lista priorizada de la capa 1 (1 = primero). */
  priority: number;
}

export interface ValidatedTriage {
  /** Hallazgos propios del modelo ya verificados, en el formato estándar de la plataforma. */
  findings: Finding[];
  /** Rechazados por no poder comprobarse (archivo o línea inexistente, evidencia que no está en el código…). */
  rejected: RejectedItem[];
  /** Hallazgos propios que el modelo mismo considera probable ruido: se guardan como nota, no como hallazgo. */
  suspected: { id: string; title: string; file_path: string }[];
  dismissals: {
    accepted: { ref: string; reason: string }[];
    /** Descartes que se ignoraron, con el motivo (secretos, coincidencias deterministas confirmadas, sin motivo suficiente…). */
    ignored: { ref: string; why: string }[];
  };
  groups: { title: string; refs: string[]; rationale: string }[];
  annotations: TriageAnnotation[];
  /** Descartes que contradicen una coincidencia determinista confirmada (insumo del escalamiento). */
  conflicts: string[];
}

const MIN_EVIDENCE_CHARS = 8;
const MIN_DISMISS_REASON_CHARS = 20;
const SEVERITY_RANK = { info: 0, low: 1, medium: 2, high: 3, critical: 4 } as const;
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

export interface ValidationContext {
  checkoutPath: string;
  /** El diff que se le mostró al modelo (ya redactado) y los archivos que toca. */
  diffText: string;
  refMap: Map<string, NormalizedFinding>;
  /** Para anotar cada hallazgo de la capa 1 por prioridad. */
  orderedRefs: string[];
}

async function loadFile(checkoutPath: string, rel: string): Promise<string | null> {
  if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) return null;
  try {
    const buf = await readFile(join(checkoutPath, rel));
    if (buf.length > 2_000_000 || buf.includes(0)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

export async function validateTriage(result: TriageResult, ctx: ValidationContext): Promise<ValidatedTriage> {
  const diffNorm = norm(ctx.diffText);
  const out: ValidatedTriage = { findings: [], rejected: [], suspected: [], dismissals: { accepted: [], ignored: [] }, groups: [], annotations: [], conflicts: [] };
  const fileCache = new Map<string, string | null>();
  const fileOf = async (rel: string) => {
    if (!fileCache.has(rel)) fileCache.set(rel, await loadFile(ctx.checkoutPath, rel));
    return fileCache.get(rel)!;
  };

  // ---- hallazgos propios del modelo
  let n = 0;
  for (const f of result.findings) {
    const id = f.id || `L2-${n + 1}`;
    const reject = (reason: string) => out.rejected.push({ id, title: f.title.slice(0, 120), reason });
    const rel = f.file_path.replace(/^\.\//, '').replace(/^\/+/, '');

    if (f.validation_status === 'false_positive_suspected') {
      out.suspected.push({ id, title: f.title.slice(0, 120), file_path: rel });
      continue;
    }
    const content = await fileOf(rel);
    if (content === null) {
      reject(`el archivo "${rel}" no existe en el repositorio`);
      continue;
    }
    const lineCount = content.split(/\r?\n/).length;
    if ((f.line_start !== null && (f.line_start < 1 || f.line_start > lineCount)) || (f.line_end !== null && f.line_end > lineCount)) {
      reject(`la línea indicada no existe en "${rel}" (tiene ${lineCount})`);
      continue;
    }
    const evidence = norm(f.evidence);
    if (evidence.length < MIN_EVIDENCE_CHARS) {
      reject('sin evidencia citada del código');
      continue;
    }
    // La cita puede venir de la versión redactada del archivo o del diff: se acepta si aparece en cualquiera.
    const found = norm(content).includes(evidence) || norm(redactSecrets(content)).includes(evidence) || diffNorm.includes(evidence);
    if (!found) {
      reject('la evidencia citada no aparece en el código del repositorio ni en el diff');
      continue;
    }

    const refs = [...new Set(f.source_refs)].filter((r) => ctx.refMap.has(r));
    const validation: ValidationStatus = f.validation_status;
    // Un hallazgo sin comprobar no puede ser grave: la severidad definitiva se fija cuando se confirme.
    const severity = validation === 'confirmed' ? f.severity : SEVERITY_RANK[f.severity] > SEVERITY_RANK.medium ? 'medium' : f.severity;
    n += 1;
    out.findings.push({
      category: f.category,
      severity,
      file_path: rel,
      line_start: f.line_start,
      line_end: f.line_end,
      title: f.title,
      explanation: `${f.scenario}\n\nImpacto: ${f.impact}\n\nEvidencia: ${f.evidence.slice(0, 400)}`,
      suggested_fix: { type: 'text', description: f.recommendation },
      confidence: Math.min(1, Math.max(0, f.confidence)),
      violated_rule: null,
      question: null,
      verify_with: null,
      validation_status: validation,
      source_refs: refs.map((r) => ctx.refMap.get(r)!.fingerprint),
    });
  }

  // ---- descartes de hallazgos de los escáneres
  const dismissedRefs = new Set<string>();
  for (const d of result.dismissed) {
    const finding = ctx.refMap.get(d.ref);
    if (!finding) {
      out.dismissals.ignored.push({ ref: d.ref, why: 'la referencia no existe' });
      continue;
    }
    if (d.reason.trim().length < MIN_DISMISS_REASON_CHARS) {
      out.dismissals.ignored.push({ ref: d.ref, why: 'el descarte no trae un motivo suficiente' });
      continue;
    }
    if (finding.category === 'secret') {
      out.dismissals.ignored.push({ ref: d.ref, why: 'un secreto nunca se descarta por la opinión de un modelo' });
      out.conflicts.push(`${d.ref}: el modelo quiso descartar un secreto`);
      continue;
    }
    if (finding.validation === 'confirmed') {
      out.dismissals.ignored.push({ ref: d.ref, why: 'es una coincidencia determinista confirmada: se mantiene (solo una excepción aprobada puede anularla)' });
      out.conflicts.push(`${d.ref}: el modelo quiso descartar un hallazgo determinista confirmado (${finding.ruleId})`);
      continue;
    }
    dismissedRefs.add(d.ref);
    out.dismissals.accepted.push({ ref: d.ref, reason: d.reason.trim().slice(0, 500) });
  }

  // ---- grupos y anotaciones por hallazgo
  const groupOf = new Map<string, string>();
  for (const g of result.groups) {
    const refs = [...new Set(g.finding_refs)].filter((r) => ctx.refMap.has(r));
    if (refs.length === 0) continue;
    out.groups.push({ title: g.title.slice(0, 160), refs, rationale: g.rationale.slice(0, 500) });
    for (const r of refs) if (!groupOf.has(r)) groupOf.set(r, g.title.slice(0, 160));
  }
  ctx.orderedRefs.forEach((ref, i) => {
    const finding = ctx.refMap.get(ref);
    if (!finding) return;
    const accepted = out.dismissals.accepted.find((d) => d.ref === ref);
    out.annotations.push({
      fingerprint: finding.fingerprint,
      ref,
      group: groupOf.get(ref) ?? null,
      dismissed: dismissedRefs.has(ref),
      note: accepted?.reason ?? out.dismissals.ignored.find((d) => d.ref === ref)?.why ?? null,
      priority: i + 1,
    });
  });
  return out;
}
