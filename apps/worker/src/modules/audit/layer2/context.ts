import { readFile } from 'fs/promises';
import { join } from 'path';
import type { ProjectProfile, RecentCommit, TriageCodeContext, TriageInput, TriageScannerFinding } from '@devsentinel/llm-port';
import { redactSecrets } from '../../../common/redact';
import { truncateDiff } from '../../review/diffUtils';
import { buildSymbolUsages } from '../../review/reviewToolbox';
import { SEVERITY_ORDER } from '../normalize';
import type { Layer1Result, NormalizedFinding } from '../types';
import { classifyChange } from './changeProfile';

/** Qué se le entrega al modelo de triaje: nunca el repositorio completo. */
export const TRIAGE_LIMITS = {
  maxDiffChars: Number(process.env.AUDIT_L2_MAX_DIFF_CHARS) || 60_000,
  maxFindings: 80,
  maxSnippets: 40,
  snippetRadius: 12,
  maxSnippetChars: 3_000,
  maxSymbolUsageChars: 6_000,
};

const BASELINE_LABEL = { new: 'nuevo en este cambio', preexisting: 'preexistente', unknown: 'origen desconocido' } as const;
const VALIDATION_LABEL = { confirmed: 'confirmado', pending_validation: 'pendiente de validación', accepted_exception: 'excepción aceptada', false_positive_suspected: 'posible falso positivo' } as const;

export interface TriageContext {
  input: TriageInput;
  /** F1, F2… → hallazgo de la capa 1 al que se refiere. */
  refMap: Map<string, NormalizedFinding>;
  /** Cuántos hallazgos de la capa 1 no entraron en el contexto por el tope. */
  omittedFindings: number;
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

export async function buildTriageContext(params: {
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
}): Promise<TriageContext> {
  const { checkoutPath, layer1 } = params;

  // El diff se redacta ANTES de salir: si trae un secreto, el modelo no lo ve.
  const trimmed = truncateDiff(redactSecrets(params.diff), TRIAGE_LIMITS.maxDiffChars);

  const ranked = [...layer1.findings].sort(
    (a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || Number(b.baseline === 'new') - Number(a.baseline === 'new'),
  );
  const selected = ranked.slice(0, TRIAGE_LIMITS.maxFindings);
  const refMap = new Map<string, NormalizedFinding>();
  const scannerFindings: TriageScannerFinding[] = selected.map((f, i) => {
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

  const symbolUsages = redactSecrets(
    (await buildSymbolUsages(checkoutPath, params.diff, params.analyzedFiles).catch(() => '')).slice(0, TRIAGE_LIMITS.maxSymbolUsageChars),
  );

  const missing = layer1.coverage.missing;
  const coverageNote = missing.length
    ? `NO terminaron: ${missing.map((m) => `${m.tool} (${m.status})`).join(', ')}. La ausencia de hallazgos de esas herramientas NO significa que esté limpio.`
    : 'Todos los escáneres aplicables terminaron.';

  return {
    input: {
      repositoryFullName: params.repositoryFullName,
      commitSha: params.commitSha,
      branch: params.branch,
      baseBranch: params.baseBranch,
      pullNumber: params.pullNumber,
      changeTags: classifyChange(params.analyzedFiles).map((t) => ({ tag: t.tag, files: t.files })),
      diff: trimmed.diff,
      diffNote: trimmed.note,
      scannerFindings,
      coverageNote,
      codeContext,
      symbolUsages: symbolUsages || undefined,
      projectProfile: params.projectProfile,
      recentCommits: params.recentCommits,
    },
    refMap,
    omittedFindings: Math.max(0, ranked.length - selected.length),
  };
}
