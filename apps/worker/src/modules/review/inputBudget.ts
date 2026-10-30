import { tokenEstimator, type ReviewDiffInput, type StaticAnalysisFinding } from '@devsentinel/llm-port';

/** Presupuesto de entrada de los prompts. Un commit enorme (lockfiles, código generado, cientos de archivos) no puede viajar entero al
 * modelo: Bedrock responde 400 "Your input exceeds the context window". Además, por encima de 272K tokens de entrada cobra la tarifa de
 * contexto largo (el doble) sobre toda la solicitud. Aquí viven las piezas que reducen el contenido SIN perder lo importante:
 *   - relevancia: lo que entra primero es lo que toca hallazgos, lo sensible y el código (no tests ni docs),
 *   - resumen de lo de bajo valor (lockfiles, generados) en una línea,
 *   - fragmentación lógica: un archivo gigante se parte por hunks y un cambio grande por grupos de archivos,
 *   - recorte explícito de lo que no cabe, siempre nombrándolo. */
export const INPUT_LIMITS = {
  /** Tope global de tokens de entrada de la revisión general (LLM_MAX_INPUT_TOKENS). La ventana real de cada modelo puede bajarlo. */
  maxInputTokens: Number(process.env.LLM_MAX_INPUT_TOKENS) || 150_000,
  /** Un solo archivo no puede acaparar el presupuesto del diff. */
  maxFileChars: 30_000,
  /** Reserva para las instrucciones del sistema y el esquema de respuesta. */
  systemReserveChars: 12_000,
  maxListedFiles: 300,
  maxContextChars: 30_000,
  maxStaticFindings: 100,
  maxRecentCommits: 10,
  minDiffChars: 20_000,
};

/** Caracteres que caben en `tokens` según lo que ese modelo realmente ha cobrado (estimador calibrado), o la relación conservadora. */
export function charsForTokens(tokens: number, model?: string): number {
  return Math.floor(tokens * (model ? tokenEstimator.charsPerToken(model) : 3));
}

/** Archivos que casi nunca aportan a una revisión de código y sí pueden pesar megabytes. Los escáneres deterministas (Trivy para los
 * lockfiles) ya los cubren, así que omitirlos del prompt no deja la revisión sin verificar. Debe mantenerse igual que en la página del
 * commit (apps/web/app/(app)/review-runs/[id]/page.tsx). */
export function isLowValueFile(path: string): boolean {
  const p = path.toLowerCase();
  const name = p.split('/').pop() ?? p;
  return (
    /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|gemfile\.lock|go\.sum|poetry\.lock|pipfile\.lock|uv\.lock|cargo\.lock|packages\.lock\.json|mix\.lock|pubspec\.lock|podfile\.lock|gradle\.lockfile)$/.test(p) ||
    /\.(lock|min\.js|min\.css|map|snap|svg|png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|eot|zip|gz|tgz|jar|class|exe|dll|so|bin|mp4|mov)$/.test(name) ||
    /(^|\/)(node_modules|vendor|dist|build|\.next|__snapshots__|coverage|\.yarn)\//.test(p) ||
    /(\.generated\.|_pb2\.py$|\.pb\.go$|\.g\.dart$|\.designer\.cs$)/.test(name)
  );
}

/** Qué archivos importan más para ESTA auditoría (los demás se resumen u omiten primero). */
export interface RelevanceHints {
  /** Archivos con hallazgos graves o confirmados (de los escáneres o del triaje). */
  priority?: ReadonlySet<string>;
  /** Archivos de un tipo de cambio sensible (auth, IAM, CI/CD, migraciones, pagos…). */
  sensitive?: ReadonlySet<string>;
}

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py|php|java|kt|go|rb|cs|rs|swift|scala|sql|tf|ya?ml|sh|c|cc|cpp|h)$/i;
const TESTS = /(^|\/)(tests?|__tests__|spec|e2e|fixtures?)\/|\.(test|spec)\.[a-z]+$/i;
const DOCS = /\.(md|mdx|txt|rst)$/i;

export function relevanceScore(path: string, hints?: RelevanceHints): number {
  let score = 0;
  if (hints?.priority?.has(path)) score += 100;
  if (hints?.sensitive?.has(path)) score += 60;
  if (SOURCE.test(path)) score += 10;
  if (TESTS.test(path)) score -= 10;
  if (DOCS.test(path)) score -= 15;
  return score;
}

export interface BudgetReport {
  originalChars: number;
  finalChars: number;
  estimatedTokens: number;
  /** Archivos de bajo valor que se resumieron en una línea. */
  skippedLowValue: string[];
  /** Archivos de código a los que se les recortó el parche. */
  truncatedFiles: string[];
  /** Archivos de código que NO entraron al prompt por falta de presupuesto. */
  omittedFiles: string[];
  /** Nombres de archivo que sobraron de la lista de "archivos modificados". */
  listTrimmed: number;
  /** El modelo no vio todo el código del cambio: la revisión es parcial y no puede salir APTO. */
  partial: boolean;
  notes: string[];
}

const sections = (diff: string) => diff.split(/^(?=diff --git )/m).filter((s) => s.length > 0);
const pathOf = (section: string) => section.match(/^diff --git a\/(.+?) b\/(.+)$/m)?.[2] ?? '(desconocido)';
const lineCount = (s: string) => s.split('\n').length - 1;
const isBinary = (section: string) => /^(Binary files|GIT binary patch)/m.test(section);

interface Unit {
  /** Posición original del archivo en el diff (para devolver el orden original). */
  idx: number;
  path: string;
  text: string;
  lowValue: boolean;
  score: number;
  /** Número de parte y total, cuando un archivo gigante se partió por hunks. */
  part?: [number, number];
}

const STUB = (path: string, binary: boolean, lines: number) =>
  `diff --git a/${path} b/${path}\n[contenido omitido del análisis: ${binary ? 'archivo binario' : 'lockfile, archivo generado, minificado o de recursos'}; ${lines} líneas de parche]\n`;

/** Parte el parche de UN archivo en trozos lógicos de a lo sumo `maxChars`: por hunks (`@@`), repitiendo la cabecera del archivo en cada
 * trozo. Un hunk que por sí solo no cabe se corta con aviso (y se informa). */
function splitByHunks(section: string, maxChars: number): { parts: string[]; truncated: boolean } {
  const firstHunk = section.search(/^@@ /m);
  if (firstHunk < 0) return { parts: [section.slice(0, maxChars)], truncated: section.length > maxChars };
  const header = section.slice(0, firstHunk);
  const hunks = section.slice(firstHunk).split(/^(?=@@ )/m).filter((h) => h.length > 0);
  const parts: string[] = [];
  let truncated = false;
  let current = header;
  const room = Math.max(1000, maxChars - header.length);
  for (let hunk of hunks) {
    if (hunk.length > room) {
      hunk = `${hunk.slice(0, hunk.lastIndexOf('\n', room) + 1)}[...hunk recortado: ${lineCount(hunk)} líneas en total]\n`;
      truncated = true;
    }
    if (current.length + hunk.length > maxChars && current !== header) {
      parts.push(current);
      current = header;
    }
    current += hunk.endsWith('\n') ? hunk : `${hunk}\n`;
  }
  if (current !== header) parts.push(current);
  return { parts: parts.length ? parts : [header], truncated };
}

function toUnits(diff: string, maxFileChars: number, hints?: RelevanceHints): { units: Unit[]; skippedLowValue: string[]; truncatedFiles: string[] } {
  const skippedLowValue: string[] = [];
  const truncatedFiles: string[] = [];
  const units: Unit[] = [];
  sections(diff).forEach((section, idx) => {
    const path = pathOf(section);
    const binary = isBinary(section);
    if (binary || isLowValueFile(path)) {
      skippedLowValue.push(path);
      units.push({ idx, path, text: STUB(path, binary, lineCount(section)), lowValue: true, score: -1000 });
      return;
    }
    const score = relevanceScore(path, hints);
    if (section.length <= maxFileChars) {
      units.push({ idx, path, text: section.endsWith('\n') ? section : `${section}\n`, lowValue: false, score });
      return;
    }
    // Un archivo gigante se fragmenta por hunks en partes que caben; las partes viajan juntas siempre que se pueda.
    const { parts, truncated } = splitByHunks(section, maxFileChars);
    if (truncated) truncatedFiles.push(path);
    parts.forEach((text, i) =>
      units.push({ idx, path, text: parts.length > 1 ? `${text}[parte ${i + 1} de ${parts.length} de este archivo]\n` : text, lowValue: false, score, part: [i + 1, parts.length] }),
    );
  });
  return { units, skippedLowValue, truncatedFiles };
}

/** Reduce un diff a `budgetChars` en UN solo envío. Entra primero lo más relevante (hallazgos, cambios sensibles, código), lo de bajo valor
 * se resume en una línea, el parche de un archivo gigante se recorta y lo que no cabe se deja fuera ENTERO y se nombra. El resultado conserva
 * el orden original del diff. */
export function fitDiff(
  diff: string,
  budgetChars: number,
  hints?: RelevanceHints,
  maxFileChars = INPUT_LIMITS.maxFileChars,
): { diff: string; skippedLowValue: string[]; truncatedFiles: string[]; omittedFiles: string[] } {
  const { units, skippedLowValue, truncatedFiles } = toUnits(diff, maxFileChars, hints);
  const ranked = [...units].sort((a, b) => b.score - a.score || a.idx - b.idx);
  const chosen = new Set<Unit>();
  const omitted = new Set<string>();
  let used = 0;
  for (const u of ranked) {
    if (u.lowValue || used + u.text.length <= budgetChars || chosen.size === 0) {
      chosen.add(u);
      used += u.text.length;
    } else {
      omitted.add(u.path);
    }
  }
  // Un archivo del que entró solo una parte se cuenta como recortado (no como omitido).
  const keptPaths = new Set([...chosen].map((u) => u.path));
  const omittedFiles = [...omitted].filter((p) => !keptPaths.has(p));
  const partialFiles = [...omitted].filter((p) => keptPaths.has(p));
  const truncated = [...new Set([...truncatedFiles, ...partialFiles])];
  const text = units.filter((u) => chosen.has(u)).map((u) => u.text).join('');
  const tail = omittedFiles.length
    ? `\n[Archivos de código que NO aparecen arriba por el tamaño del cambio (${omittedFiles.length}): ${omittedFiles.slice(0, 80).join(', ')}${omittedFiles.length > 80 ? '…' : ''}]\n`
    : '';
  return { diff: text + tail, skippedLowValue, truncatedFiles: truncated, omittedFiles };
}

export interface DiffChunk {
  diff: string;
  /** Archivos (rutas) cuyo parche, completo o en parte, viaja en este fragmento. */
  files: string[];
}

export interface ChunkedDiff {
  chunks: DiffChunk[];
  skippedLowValue: string[];
  truncatedFiles: string[];
  /** Archivos de código que no entraron en ningún fragmento (se pasó de `maxChunks`). */
  omittedFiles: string[];
}

/** Fragmentación lógica de un diff grande para analizarlo en VARIAS solicitudes (cada una dentro del presupuesto) en vez de descartar código:
 * primero lo más relevante, los archivos gigantes partidos por hunks, y a lo sumo `maxChunks` fragmentos. Los resúmenes de lo de bajo valor
 * van en el primero. Cada fragmento conserva el orden original del diff. */
export function chunkDiff(diff: string, chunkChars: number, maxChunks: number, hints?: RelevanceHints): ChunkedDiff {
  const { units, skippedLowValue, truncatedFiles } = toUnits(diff, Math.min(INPUT_LIMITS.maxFileChars * 2, chunkChars), hints);
  const ranked = [...units].sort((a, b) => b.score - a.score || a.idx - b.idx || (a.part?.[0] ?? 0) - (b.part?.[0] ?? 0));
  const buckets: Unit[][] = [[]];
  const sizes = [0];
  const omitted = new Set<string>();
  for (const u of ranked) {
    if (u.lowValue) {
      buckets[0].push(u);
      sizes[0] += u.text.length;
      continue;
    }
    let placed = false;
    for (let i = 0; i < buckets.length; i++) {
      if (sizes[i] + u.text.length <= chunkChars) {
        buckets[i].push(u);
        sizes[i] += u.text.length;
        placed = true;
        break;
      }
    }
    if (!placed && buckets.length < maxChunks) {
      buckets.push([u]);
      sizes.push(u.text.length);
      placed = true;
    }
    if (!placed) omitted.add(u.path);
  }
  const placedPaths = new Set(buckets.flat().map((u) => u.path));
  const omittedFiles = [...omitted].filter((p) => !placedPaths.has(p));
  const partialFiles = [...omitted].filter((p) => placedPaths.has(p));
  const chunks: DiffChunk[] = buckets
    .filter((b) => b.length > 0)
    .map((b) => {
      const ordered = [...b].sort((x, y) => x.idx - y.idx || (x.part?.[0] ?? 0) - (y.part?.[0] ?? 0));
      return { diff: ordered.map((u) => u.text).join(''), files: [...new Set(ordered.filter((u) => !u.lowValue).map((u) => u.path))] };
    });
  return { chunks, skippedLowValue, truncatedFiles: [...new Set([...truncatedFiles, ...partialFiles])], omittedFiles };
}

const SEVERITY: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0, error: 3, warning: 2 };

export interface FitOptions {
  /** Tokens de entrada permitidos (por defecto INPUT_LIMITS.maxInputTokens). Salen de la ventana real del agente de la capa. */
  maxInputTokens?: number;
  /** Modelo que va a recibir la entrada (para usar su relación caracteres/token calibrada). */
  model?: string;
  hints?: RelevanceHints;
}

/** Ajusta la entrada de la revisión al presupuesto de tokens. Nunca falla: si el cambio no cabe, lo recorta y lo dice (en el prompt y en el
 * informe), y la revisión resultante queda marcada como parcial. `scale` (0..1) reduce todavía más el presupuesto: se usa para reintentar
 * cuando el proveedor aun así rechaza la entrada por tamaño. */
export function fitReviewInput(input: ReviewDiffInput, scale = 1, options: FitOptions = {}): { input: ReviewDiffInput; report: BudgetReport } {
  const maxChars = Math.floor(charsForTokens(options.maxInputTokens ?? INPUT_LIMITS.maxInputTokens, options.model) * scale);
  const originalChars = input.diff.length;

  const staticFindings: StaticAnalysisFinding[] =
    input.staticFindings.length > INPUT_LIMITS.maxStaticFindings
      ? [...input.staticFindings].sort((a, b) => (SEVERITY[String(b.severity).toLowerCase()] ?? 0) - (SEVERITY[String(a.severity).toLowerCase()] ?? 0)).slice(0, INPUT_LIMITS.maxStaticFindings)
      : input.staticFindings;
  const analyzedFiles = input.analyzedFiles.slice(0, INPUT_LIMITS.maxListedFiles);
  const listTrimmed = input.analyzedFiles.length - analyzedFiles.length;

  let contextChars = 0;
  const retrievedContext = input.retrievedContext.filter((c) => {
    contextChars += c.content.length;
    return contextChars <= INPUT_LIMITS.maxContextChars * scale;
  });
  const recentCommits = input.recentCommits?.slice(0, INPUT_LIMITS.maxRecentCommits).map((c) => ({ ...c, message: c.message.slice(0, 300) }));

  const overhead =
    INPUT_LIMITS.systemReserveChars +
    analyzedFiles.join(', ').length +
    staticFindings.reduce((n, f) => n + f.message.length + f.filePath.length + 60, 0) +
    retrievedContext.reduce((n, c) => n + c.content.length + 60, 0) +
    (recentCommits ?? []).reduce((n, c) => n + c.message.length + 60, 0) +
    JSON.stringify(input.projectProfile ?? {}).length;
  // 4.000 caracteres de reserva para la lista de archivos omitidos que se agrega al final del diff
  const diffBudget = Math.max(INPUT_LIMITS.minDiffChars * scale, maxChars - overhead - 4_000);

  const fitted = originalChars <= diffBudget && !hasLowValue(input.diff) ? null : fitDiff(input.diff, diffBudget, options.hints);
  const diff = fitted ? fitted.diff : input.diff;

  const omittedFiles = fitted?.omittedFiles ?? [];
  const truncatedFiles = fitted?.truncatedFiles ?? [];
  const skippedLowValue = fitted?.skippedLowValue ?? [];
  const partial = omittedFiles.length > 0 || truncatedFiles.length > 0;
  const notes: string[] = [];
  if (skippedLowValue.length) notes.push(`${skippedLowValue.length} archivo(s) de bajo valor (lockfiles, generados, minificados, binarios) se resumieron sin su parche`);
  if (truncatedFiles.length) notes.push(`se recortó el parche de ${truncatedFiles.length} archivo(s) de código por su tamaño: ${truncatedFiles.slice(0, 5).join(', ')}${truncatedFiles.length > 5 ? '…' : ''}`);
  if (omittedFiles.length) notes.push(`${omittedFiles.length} archivo(s) de código no entraron al análisis por el tamaño del cambio: ${omittedFiles.slice(0, 5).join(', ')}${omittedFiles.length > 5 ? '…' : ''}`);
  if (listTrimmed > 0) notes.push(`la lista de archivos modificados se recortó (${listTrimmed} más)`);

  const next: ReviewDiffInput = {
    ...input,
    diff,
    staticFindings,
    retrievedContext,
    recentCommits,
    analyzedFiles: listTrimmed > 0 ? [...analyzedFiles, `…y ${listTrimmed} archivos más`] : analyzedFiles,
  };
  const finalChars = diff.length + overhead;
  const ratio = options.model ? tokenEstimator.charsPerToken(options.model) : 3;
  return {
    input: next,
    report: { originalChars, finalChars, estimatedTokens: Math.ceil(finalChars / ratio), skippedLowValue, truncatedFiles, omittedFiles, listTrimmed, partial, notes },
  };
}

function hasLowValue(diff: string): boolean {
  return sections(diff).some((s) => isBinary(s) || isLowValueFile(pathOf(s)));
}

/** Frase para mostrar al usuario cuando la revisión fue parcial por tamaño. */
export function partialReason(report: BudgetReport): string | null {
  if (!report.partial) return null;
  const files = report.omittedFiles.length + report.truncatedFiles.length;
  return `Revisión parcial: el cambio es demasiado grande para el modelo y ${files} archivo(s) de código no se analizaron completos (${report.notes.filter((n) => /código/.test(n)).join('; ')}). Un análisis parcial no puede aprobarse automáticamente.`;
}
