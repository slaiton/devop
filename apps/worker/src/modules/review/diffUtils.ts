/** Recorta un diff muy grande por archivos completos (no a mitad de un archivo), en el orden en que
 * aparecen, y dice cuáles quedaron fuera para que el revisor los lea con sus herramientas. */
export function truncateDiff(diff: string, maxChars: number): { diff: string; note?: string } {
  if (diff.length <= maxChars) return { diff };
  const sections = diff.split(/^(?=diff --git )/m);
  const kept: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const section of sections) {
    const file = section.match(/^diff --git a\/(.+?) b\//)?.[1];
    if (used + section.length <= maxChars || kept.length === 0) {
      kept.push(section);
      used += section.length;
    } else if (file) {
      omitted.push(file);
    }
  }
  const joined = kept.join('');
  const hard = joined.length > maxChars ? `${joined.slice(0, maxChars)}\n[...diff recortado]\n` : joined;
  return {
    diff: hard,
    note: `el diff era demasiado grande y se recortó (${diff.length} → ${hard.length} caracteres).${
      omitted.length ? ` Archivos que NO aparecen en el diff de arriba, léelos con las herramientas: ${omitted.join(', ')}.` : ''
    }`,
  };
}
