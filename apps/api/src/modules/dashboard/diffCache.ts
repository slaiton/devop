/** Caché en memoria de los diffs que se muestran en la página del commit. El diff de un commit no cambia nunca, y pedirlo a GitHub (y
 * volver a procesarlo) en cada visita y en cada refresco de la página era lo que la volvía lenta. Acotada en cantidad y en tamaño total,
 * y junta los pedidos simultáneos del mismo diff en una sola llamada a GitHub. */
export class DiffCache {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<string>>();
  private totalChars = 0;

  constructor(
    private readonly maxEntries = 40,
    private readonly maxTotalChars = 80_000_000,
    private readonly now: () => number = Date.now,
  ) {}

  async get(key: string, ttlMs: number, load: () => Promise<string>): Promise<string> {
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > this.now()) {
      // recientemente usado: pasa al final del orden de expulsión
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.value;
    }
    if (hit) this.drop(key);

    const pending = this.inflight.get(key);
    if (pending) return pending;
    const promise = load()
      .then((value) => {
        this.put(key, value, ttlMs);
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  private put(key: string, value: string, ttlMs: number): void {
    if (value.length > this.maxTotalChars / 2) return; // un diff descomunal no se guarda (desalojaría todo lo demás)
    this.drop(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    this.totalChars += value.length;
    while (this.entries.size > this.maxEntries || this.totalChars > this.maxTotalChars) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
  }

  private drop(key: string): void {
    const e = this.entries.get(key);
    if (e) {
      this.totalChars -= e.value.length;
      this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

export interface CappedDiff {
  diff: string;
  truncated: boolean;
  totalChars: number;
  omittedFiles: string[];
}

/** Lo máximo que se conserva de UN archivo que tiene hallazgos (el archivo se corta en un salto de línea, con aviso). */
const MAX_KEEP_FILE_CHARS = 400_000;

/** Recorta un diff a `maxChars` sin partir archivos (se omiten los últimos completos) para no mandar megabytes a la página. Los archivos
 * de `keep` (los que tienen hallazgos de la revisión) se conservan SIEMPRE, aunque ya se haya llegado al tope. */
export function capDiff(diff: string, maxChars: number, keep: ReadonlySet<string> = new Set()): CappedDiff {
  if (diff.length <= maxChars) return { diff, truncated: false, totalChars: diff.length, omittedFiles: [] };
  const sections = diff.split(/^(?=diff --git )/m).filter((s) => s.length > 0);
  const pathOf = (s: string) => s.match(/^diff --git a\/(.+?) b\/(.+)$/m)?.[2] ?? '(desconocido)';
  const kept: string[] = [];
  const omittedFiles: string[] = [];
  let used = 0;
  for (const section of sections) {
    const mustKeep = keep.has(pathOf(section));
    if (mustKeep) {
      const text = section.length > MAX_KEEP_FILE_CHARS ? `${section.slice(0, section.lastIndexOf('\n', MAX_KEEP_FILE_CHARS) + 1)}[...parche recortado por su tamaño]\n` : section;
      kept.push(text);
      used += text.length;
    } else if (used + section.length <= maxChars || kept.length === 0) {
      kept.push(section);
      used += section.length;
    } else {
      omittedFiles.push(pathOf(section));
    }
  }
  return { diff: kept.join(''), truncated: true, totalChars: diff.length, omittedFiles: omittedFiles.slice(0, 300) };
}
