import { readFile } from 'fs/promises';
import { join } from 'path';
import type { ProjectProfile, RecentCommit, TriageCodeContext, TriageInput, TriageScannerFinding } from '@devsentinel/llm-port';
import { redactSecrets } from '../../../common/redact';
import { fitDiff, type DiffChunk, type RelevanceHints } from '../../review/inputBudget';
import { buildSymbolUsages } from '../../review/reviewToolbox';
import { SEVERITY_ORDER } from '../normalize';
import type { Layer1Result, NormalizedFinding } from '../types';
import { classifyChange } from './changeProfile';
import { escalationConfigFromEnv } from './escalation';

/** Qué se le entrega al modelo de triaje: nunca el repositorio completo, y si el cambio es grande, en VARIOS fragmentos que caben cada uno
 * en el presupuesto (ver `chunkDiff`), no descartando código. */
export const TRIAGE_LIMITS = {
  maxFindings: 80,
  maxSnippets: 40,
  snippetRadius: 12,
  maxSnippetChars: 3_000,
  maxSymbolUsageChars: 6_000,
  /** Reserva para las instrucciones del sistema y el esquema de la respuesta. */
  systemReserveChars: 9_000,
};

const BASELINE_LABEL = { new: 'nuevo en este cambio', preexisting: 'preexistente', unknown: 'origen desconocido' } as const;
const VALIDATION_LABEL = { confirmed: 'confirmado', pending_validation: 'pendiente de validación', accepted_exception: 'excepción aceptada', false_positive_suspected: 'posible falso positivo' } as const;

/** Todo lo que NO es el diff y es común a los fragmentos: hallazgos con su referencia, fragmentos de código, perfil, etiquetas, etc. */
export interface TriageBase {
  repositoryFullName: string;
  commitSha: string;
  branch: string | null;
  baseBranch: string | null;
  pullNumber: number | null;
  changeTags: { tag: string; files: string[] }[];
  /** El diff COMPLETO ya redactado (los secretos nunca salen). Se usa para fragmentar y para comprobar las citas del modelo. */
  redactedDiff: string;
  findings: TriageScannerFinding[];
  codeContext: TriageCodeContext[];
  symbolUsages?: string;
  coverageNote: string;
  projectProfile?: ProjectProfile;
  recentCommits?: RecentCommit[];
  /** F1, F2… → hallazgo de la capa 1 al que se refiere. */
  refMap: Map<string, NormalizedFinding>;
  /** Cuántos hallazgos de la capa 1 no entraron en el contexto por el tope. */
  omittedFindings: number;
  /** Qué archivos importan más (hallazgos y cambios sensibles): entran primero cuando no cabe todo. */
  hints: RelevanceHints;
  /** Caracteres que ocupa todo lo que no es el diff (para calcular cuánto diff cabe por fragmento). */
  overheadChars: number;
}

/** Lee `radius` líneas alrededor de `line` del checkout. Solo rutas relativas dentro del repo, sin binarios; el texto sale redactado. */
export async function readExcerpt(checkoutPath: string, rel: string, line: number, radius: number): Promise<TriageCodeContext | null> {
  if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) return null;
  try {
    const buf = await readFile(join(checkoutPath, rel));
    if (buf.length > 2_000_000 || buf.includes(0)) return null;
    const lines = buf.toString('utf8').split(/\r?\n/);
    const start = Math.max(1, line - radius);
    const end = Math.min(lines.length, line + radius);
    if (start > lines.length) return null;
    const text = lines
      .slice(start - 1, end)
      .map((l, i) => `${start + i}: ${l}`)
      .join('\n');
    return { filePath: rel, startLine: start, text: redactSecrets(text).slice(0, TRIAGE_LIMITS.maxSnippetChars) };
  } catch {
    return null;
  }
}

export async function buildTriageBase(params: {
  repositoryFullName: string;
  commitSha: string;
  branch: string | null;
  baseBranch: string | null;
  pullNumber: number | null;
  checkoutPath: string;
  diff: string;
  analyzedFiles: string[];
  layer1: Layer1Result;
  projectProfile?: ProjectProfile;
  recentCommits?: RecentCommit[];
}): Promise<TriageBase> {
  const { checkoutPath, layer1 } = params;

  // El diff se redacta ANTES de salir: si trae un secreto, el modelo no lo ve.
  const redactedDiff = redactSecrets(params.diff);

  const ranked = [...layer1.findings].sort(
    (a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || Number(b.baseline === 'new') - Number(a.baseline === 'new'),
  );
  const selected = ranked.slice(0, TRIAGE_LIMITS.maxFindings);
  const refMap = new Map<string, NormalizedFinding>();
  const findings: TriageScannerFinding[] = selected.map((f, i) => {
    const ref = `F${i + 1}`;
    refMap.set(ref, f);
    return {
      ref,
      tool: f.sources.map((s) => s.tool).join('+'),
      ruleId: f.ruleId,
      severity: f.severity,
      category: f.category,
      filePath: f.filePath,
      line: f.lineStart ?? null,
      message: redactSecrets(f.message).slice(0, 400),
      baseline: BASELINE_LABEL[f.baseline],
      validation: VALIDATION_LABEL[f.validation],
      packageName: f.packageName,
      installedVersion: f.installedVersion,
      fixedVersion: f.fixedVersion,
    };
  });

  // Fragmentos de código SOLO de los hallazgos que los tienen (los secretos y las dependencias no llevan código).
  const codeContext: TriageCodeContext[] = [];
  const seen: { file: string; line: number }[] = [];
  for (const f of selected) {
    if (codeContext.length >= TRIAGE_LIMITS.maxSnippets) break;
    if (f.category === 'secret' || f.category === 'dependency' || !f.lineStart) continue;
    if (seen.some((s) => s.file === f.filePath && Math.abs(s.line - f.lineStart!) <= TRIAGE_LIMITS.snippetRadius)) continue;
    const excerpt = await readExcerpt(checkoutPath, f.filePath, f.lineStart, TRIAGE_LIMITS.snippetRadius);
    if (excerpt) {
      codeContext.push(excerpt);
      seen.push({ file: f.filePath, line: f.lineStart });
    }
  }

  // Los usos de cada símbolo se buscan sobre una versión REDUCIDA del diff: hacerlo sobre un diff gigante es lentísimo y no aporta.
  const forSymbols = fitDiff(redactedDiff, 120_000).diff;
  const symbolUsages = redactSecrets((await buildSymbolUsages(checkoutPath, forSymbols, params.analyzedFiles.slice(0, 300)).catch(() => '')).slice(0, TRIAGE_LIMITS.maxSymbolUsageChars));

  const missing = layer1.coverage.missing;
  const coverageNote = missing.length
    ? `NO terminaron: ${missing.map((m) => `${m.tool} (${m.status})`).join(', ')}. La ausencia de hallazgos de esas herramientas NO significa que esté limpio.`
    : 'Todos los escáneres aplicables terminaron.';

  const changeTags = classifyChange(params.analyzedFiles).map((t) => ({ tag: t.tag, files: t.files }));
  const sensitiveTags = new Set(escalationConfigFromEnv().sensitiveTags);
  const hints: RelevanceHints = {
    priority: new Set(layer1.findings.filter((f) => f.severity === 'critical' || f.severity === 'high' || f.baseline === 'new').map((f) => f.filePath)),
    sensitive: new Set(changeTags.filter((t) => sensitiveTags.has(t.tag)).flatMap((t) => t.files)),
  };

  const overheadChars =
    TRIAGE_LIMITS.systemReserveChars +
    JSON.stringify({ findings, codeContext, symbolUsages, changeTags, profile: params.projectProfile, commits: params.recentCommits?.slice(0, 8) }).length;

  return {
    repositoryFullName: params.repositoryFullName,
    commitSha: params.commitSha,
    branch: params.branch,
    baseBranch: params.baseBranch,
    pullNumber: params.pullNumber,
    changeTags,
    redactedDiff,
    findings,
    codeContext,
    symbolUsages: symbolUsages || undefined,
    coverageNote,
    projectProfile: params.projectProfile,
    recentCommits: params.recentCommits,
    refMap,
    omittedFindings: Math.max(0, ranked.length - selected.length),
    hints,
    overheadChars,
  };
}

/** La entrada del triaje para UN fragmento del diff: el fragmento y solo los hallazgos y fragmentos de código de SUS archivos. Lo que no
 * pertenece a ningún fragmento (dependencias, hallazgos de archivos fuera del cambio) viaja en el primero. */
export function triageInputForChunk(base: TriageBase, chunk: DiffChunk, index: number, total: number, allChunkFiles: ReadonlySet<string>): TriageInput {
  const mine = new Set(chunk.files);
  const takes = (file: string) => mine.has(file) || (index === 0 && !allChunkFiles.has(file));
  const note =
    total > 1
      ? `Parte ${index + 1} de ${total} del cambio: este fragmento trae ${chunk.files.length} archivo(s); el resto del cambio se analiza en las otras partes y los hallazgos de los escáneres se reparten entre ellas. Los demás archivos no son tu trabajo aquí.`
      : undefined;
  return {
    repositoryFullName: base.repositoryFullName,
    commitSha: base.commitSha,
    branch: base.branch,
    baseBranch: base.baseBranch,
    pullNumber: base.pullNumber,
    changeTags: base.changeTags,
    diff: chunk.diff,
    diffNote: note,
    scannerFindings: base.findings.filter((f) => takes(f.filePath)),
    coverageNote: base.coverageNote,
    codeContext: base.codeContext.filter((c) => takes(c.filePath)),
    symbolUsages: index === 0 ? base.symbolUsages : undefined,
    projectProfile: base.projectProfile,
    recentCommits: base.recentCommits,
  };
}
