export interface DiffRanges {
  /** Archivos tocados por el diff (incluye binarios y renombrados), con rutas del lado "nuevo". */
  files: Set<string>;
  /** Líneas AGREGADAS por archivo, como rangos [inicio, fin] (numeración del archivo nuevo). */
  added: Map<string, [number, number][]>;
}

/** Interpreta un diff unificado de git y devuelve qué archivos y qué líneas cambiaron. Sirve para separar los hallazgos
 * NUEVOS de los que ya estaban en el código (preexistentes) sin escanear la rama base. */
export function parseDiffRanges(diff: string): DiffRanges {
  const files = new Set<string>();
  const added = new Map<string, [number, number][]>();
  let current: string | null = null;
  let newLine = 0;
  let runStart = 0;
  let inHunk = false;

  const closeRun = (end: number) => {
    if (current && runStart > 0 && end >= runStart) {
      const list = added.get(current) ?? [];
      list.push([runStart, end]);
      added.set(current, list);
    }
    runStart = 0;
  };

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (inHunk) closeRun(newLine - 1);
      inHunk = false;
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      current = match ? match[2] : null;
      if (current) files.add(current);
      continue;
    }
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim();
      if (path !== '/dev/null') {
        current = path.replace(/^b\//, '');
        files.add(current);
      }
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      if (inHunk) closeRun(newLine - 1);
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || !current) continue;
    if (line.startsWith('+')) {
      if (runStart === 0) runStart = newLine;
      newLine += 1;
    } else if (line.startsWith('-')) {
      closeRun(newLine - 1);
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file"
    } else {
      closeRun(newLine - 1);
      newLine += 1;
    }
  }
  if (inHunk) closeRun(newLine - 1);
  return { files, added };
}
