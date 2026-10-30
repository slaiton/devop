import type { ReviewDiffInput, StaticAnalysisFinding } from '@devsentinel/llm-port';
import { isLowValueFile } from '../review/inputBudget';
import { SEVERITY_ORDER } from './normalize';
import type { Layer1Result, NormalizedFinding } from './types';
import { escalationConfigFromEnv } from './layer2/escalation';
import type { Layer2Outcome } from './layer2/layer2.service';

/** Compresión de contexto entre capas. La capa avanzada (Sol) NUNCA recibe otra vez el código completo si la capa 2 ya lo auditó: recibe un
 * resumen ejecutivo, los hallazgos graves con su evidencia y las conclusiones del triaje, más el parche SOLO de los archivos que importan. */

const SERIOUS = (f: NormalizedFinding) =>
  (f.severity === 'critical' || f.severity === 'high') && f.baseline !== 'preexisting' && f.validation !== 'false_positive_suspected' && f.validation !== 'accepted_exception';

/** Capa 1 → resto: solo métricas y los hallazgos que importan (nunca la lista completa de los escáneres). */
export function layer1Metrics(layer1: Layer1Result): string {
  const bySeverity: Record<string, number> = {};
  const byTool: Record<string, number> = {};
  for (const f of layer1.findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    for (const s of f.sources) byTool[s.tool] = (byTool[s.tool] ?? 0) + 1;
  }
  const fresh = layer1.findings.filter((f) => f.baseline === 'new').length;
  const parts = [
    `Escáneres: ${layer1.runs.filter((r) => r.status === 'ok').length} terminaron bien, ${layer1.runs.filter((r) => r.status === 'skipped').length} no aplicaban${layer1.coverage.missing.length ? `, NO terminaron: ${layer1.coverage.missing.map((m) => m.tool).join(', ')}` : ''}.`,
    `Hallazgos: ${layer1.findings.length} en total (${fresh} nuevos en este cambio, ${layer1.findings.length - fresh} preexistentes o de origen desconocido).`,
    `Por severidad: ${Object.entries(bySeverity).map(([k, v]) => `${k} ${v}`).join(', ') || 'ninguno'}. Por herramienta: ${Object.entries(byTool).map(([k, v]) => `${k} ${v}`).join(', ') || 'ninguna'}.`,
  ];
  return parts.join('\n');
}

/** Resultado de la capa 2 comprimido para la capa 3: resumen ejecutivo, riesgo, hallazgos con su evidencia, agrupaciones, descartes y motivos
 * de escalamiento. Acotado a ~`maxChars` (la evidencia y los textos largos se recortan, nunca se omiten los hallazgos graves). */
export function compressTriage(layer1: Layer1Result, layer2: Layer2Outcome, maxChars = 7_000): string {
  const v = layer2.validated;
  const result = layer2.reviewResult;
  const lines: string[] = [
    `# Triaje de la capa 2 (${layer2.model ?? 'triaje'}): resumen de la auditoría previa`,
    result ? `Veredicto del triaje: ${result.resultado} · calidad ${result.quality_score}/100 · riesgo ${result.risk_level}.` : '',
    result ? `Resumen ejecutivo: ${result.resumen_ejecutivo.replace(/\s+/g, ' ').slice(0, 1200)}` : '',
    result?.justificacion_final ? `Justificación: ${result.justificacion_final.replace(/\s+/g, ' ').slice(0, 600)}` : '',
    '',
    '## Capa 1 (métricas)',
    layer1Metrics(layer1),
  ];

  const serious = layer1.findings.filter(SERIOUS).slice(0, 15);
  if (serious.length) {
    lines.push('', '## Hallazgos graves de los escáneres (nuevos en este cambio)');
    for (const f of serious) lines.push(`- [${f.sources.map((s) => `${s.tool}/${s.ruleId}`).join('+')}] ${f.severity.toUpperCase()} ${f.filePath}${f.lineStart ? `:${f.lineStart}` : ''} — ${f.message.slice(0, 200)}`);
  }
  if (v?.findings.length) {
    lines.push('', '## Hallazgos del triaje (verificados contra el repositorio)');
    for (const f of v.findings.slice(0, 15)) {
      lines.push(`- ${f.severity.toUpperCase()} (${f.validation_status}) ${f.file_path}${f.line_start ? `:${f.line_start}` : ''} — ${f.title}: ${String(f.explanation).replace(/\s+/g, ' ').slice(0, 450)}`);
    }
  }
  if (v?.groups.length) {
    lines.push('', '## Agrupaciones');
    for (const g of v.groups.slice(0, 8)) lines.push(`- ${g.title} (${g.refs.join(', ')}): ${g.rationale.slice(0, 200)}`);
  }
  if (v && v.dismissals.accepted.length) lines.push('', `## Falsos positivos aceptados: ${v.dismissals.accepted.length}`, ...v.dismissals.accepted.slice(0, 6).map((d) => `- ${d.ref}: ${d.reason.slice(0, 160)}`));
  if (v && v.dismissals.ignored.length) lines.push('', `## Descartes del modelo que la aplicación NO aceptó: ${v.dismissals.ignored.length} (se mantienen los hallazgos)`);
  if (layer2.escalation.triggers.length) {
    lines.push('', '## Por qué se pide una auditoría avanzada');
    for (const t of layer2.escalation.triggers) lines.push(`- ${t.type}: ${t.detail.slice(0, 250)}`);
  }
  if (layer2.changeTags.length) lines.push('', `Tipo de cambio: ${layer2.changeTags.map((t) => `${t.tag} (${t.files.length} archivos)`).join(', ')}.`);
  if (layer2.partial) lines.push('', 'ATENCIÓN: la capa 2 no vio todo el código del cambio (era demasiado grande).');

  const text = lines.filter((l) => l !== undefined).join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[...resumen recortado]` : text;
}

/** Archivos que SÍ merecen que la capa avanzada vea su parche: los de hallazgos graves o del triaje y los de un cambio sensible. */
export function priorityFiles(layer1: Layer1Result, layer2: Layer2Outcome): { priority: Set<string>; sensitive: Set<string> } {
  const priority = new Set<string>();
  for (const f of layer1.findings.filter(SERIOUS)) priority.add(f.filePath);
  for (const f of layer2.validated?.findings ?? []) priority.add(f.file_path);
  const sensitive = new Set<string>();
  const sensitiveTags = new Set(escalationConfigFromEnv().sensitiveTags);
  for (const t of layer2.changeTags) if (sensitiveTags.has(t.tag)) for (const f of t.files) sensitive.add(f);
  return { priority, sensitive };
}

/** Entrada comprimida para la capa avanzada. Parte de la entrada normal de la revisión y la REDUCE: el diff solo trae los archivos que
 * importan (el resto queda como una lista de nombres), los hallazgos de analizadores se limitan a los graves y todo el contexto previo se
 * sustituye por el resumen de la capa 2. */
export function buildLayer3Input(original: ReviewDiffInput, layer1: Layer1Result, layer2: Layer2Outcome): { input: ReviewDiffInput; priority: Set<string>; sensitive: Set<string> } {
  const { priority, sensitive } = priorityFiles(layer1, layer2);
  const keep = new Set([...priority, ...sensitive]);

  // Solo los parches de los archivos que importan; si no hay ninguno marcado, se conserva el diff (el ajuste por presupuesto hará el resto).
  const sections = original.diff.split(/^(?=diff --git )/m).filter((s) => s.length > 0);
  const pathOf = (s: string) => s.match(/^diff --git a\/(.+?) b\/(.+)$/m)?.[2] ?? '';
  const picked = keep.size > 0 ? sections.filter((s) => keep.has(pathOf(s)) && !isLowValueFile(pathOf(s))) : sections;
  const others = sections.map(pathOf).filter((p) => p && !keep.has(p));
  const diff =
    picked.join('') +
    (keep.size > 0 && others.length
      ? `\n[El parche de otros ${others.length} archivo(s) no se reenvía: ya lo auditó la capa 2 (ver su resumen). Archivos: ${others.slice(0, 60).join(', ')}${others.length > 60 ? '…' : ''}]\n`
      : '');

  const staticFindings: StaticAnalysisFinding[] = original.staticFindings
    .filter((f) => ['critical', 'high', 'error'].includes(String(f.severity).toLowerCase()))
    .sort((a, b) => (SEVERITY_ORDER[String(b.severity).toLowerCase() as keyof typeof SEVERITY_ORDER] ?? 0) - (SEVERITY_ORDER[String(a.severity).toLowerCase() as keyof typeof SEVERITY_ORDER] ?? 0))
    .slice(0, 30);

  return {
    priority,
    sensitive,
    input: {
      ...original,
      diff: diff || original.diff,
      staticFindings,
      retrievedContext: [{ filePath: '(resumen de la auditoría previa)', content: compressTriage(layer1, layer2) }],
      recentCommits: original.recentCommits?.slice(0, 5),
    },
  };
}
