import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { safeSnippet } from '../../common/redact';
import type { DiffRanges } from './diffRanges';
import type { BaselineStatus, NormalizedFinding, RawFinding, Severity } from './types';

export const SEVERITY_ORDER: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** Líneas del archivo (cacheadas por corrida). Lee solo dentro del checkout y nunca sigue rutas con "..". */
class LineReader {
  private cache = new Map<string, string[] | null>();
  constructor(private readonly checkoutPath: string) {}

  async lines(file: string): Promise<string[] | null> {
    if (this.cache.has(file)) return this.cache.get(file)!;
    let lines: string[] | null = null;
    if (!file.split('/').includes('..')) {
      try {
        const buf = await readFile(join(this.checkoutPath, file));
        if (buf.length <= 2_000_000 && !buf.includes(0)) lines = buf.toString('utf8').split(/\r?\n/);
      } catch {
        lines = null;
      }
    }
    this.cache.set(file, lines);
    return lines;
  }

  async text(file: string, start?: number, end?: number): Promise<string | undefined> {
    if (!start) return undefined;
    const all = await this.lines(file);
    if (!all) return undefined;
    const last = Math.min(end ?? start, start + 4, all.length);
    return all.slice(start - 1, last).join('\n');
  }
}

/** Huella estable: se calcula sobre el CONTENIDO afectado (no sobre el número de línea) para reconocer el mismo problema
 * entre commits aunque el archivo se desplace, y poder registrar una excepción sobre ella. Nunca guarda el contenido. */
function fingerprintOf(f: RawFinding, lineText: string | undefined): string {
  if (f.category === 'dependency') return sha(['dep', f.vulnId ?? f.ruleId, f.packageName, f.installedVersion, f.filePath].join('|'));
  const content = (lineText ?? '').replace(/\s+/g, ' ').trim();
  return sha([f.tool, f.ruleId, f.filePath, content || `L${f.lineStart ?? 0}`].join('|'));
}

/** Dos herramientas que reportan lo mismo (p. ej. Gitleaks y una regla de secretos de Semgrep en la misma línea). */
function crossToolKey(f: RawFinding): string | null {
  if (f.category === 'secret') return `secret|${f.filePath}|${f.lineStart ?? 0}`;
  return null;
}

function classify(f: RawFinding, ranges: DiffRanges | null): BaselineStatus {
  if (!ranges || ranges.files.size === 0) return 'unknown';
  if (!ranges.files.has(f.filePath)) return 'preexisting';
  // Dependencias y hallazgos de archivo completo: nuevos si el archivo (manifiesto) cambió.
  if (f.category === 'dependency' || f.lineStart === undefined) return 'new';
  const added = ranges.added.get(f.filePath) ?? [];
  const start = f.lineStart;
  const end = f.lineEnd ?? f.lineStart;
  return added.some(([a, b]) => start <= b && end >= a) ? 'new' : 'preexisting';
}

/** Normaliza (evidencia redactada, huella), deduplica entre herramientas y separa nuevos de preexistentes.
 * Orden de salida: severidad descendente, luego nuevos primero. */
export async function normalizeFindings(raw: RawFinding[], checkoutPath: string, ranges: DiffRanges | null): Promise<NormalizedFinding[]> {
  const reader = new LineReader(checkoutPath);
  const byKey = new Map<string, NormalizedFinding>();

  for (const f of raw) {
    const lineText = f.category === 'dependency' ? undefined : (await reader.text(f.filePath, f.lineStart, f.lineEnd)) ?? f.snippet;
    const fingerprint = fingerprintOf(f, lineText);
    const key = crossToolKey(f) ?? fingerprint;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.sources.some((s) => s.tool === f.tool && s.ruleId === f.ruleId)) existing.sources.push({ tool: f.tool, ruleId: f.ruleId });
      if (SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[existing.severity]) existing.severity = f.severity;
      // Si cualquiera de las dos fuentes es una coincidencia exacta, el hallazgo queda confirmado.
      if (f.validation === 'confirmed') existing.validation = 'confirmed';
      continue;
    }
    const { snippet: _drop, ...rest } = f;
    byKey.set(key, {
      ...rest,
      // Los secretos no llevan evidencia: ni redactada. El resto, un fragmento corto con redacción de respaldo.
      evidence: f.category === 'secret' || !lineText ? null : safeSnippet(lineText),
      fingerprint,
      baseline: classify(f, ranges),
      sources: [{ tool: f.tool, ruleId: f.ruleId }],
    });
  }

  return [...byKey.values()].sort(
    (a, b) =>
      SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] ||
      Number(b.baseline === 'new') - Number(a.baseline === 'new') ||
      a.filePath.localeCompare(b.filePath) ||
      (a.lineStart ?? 0) - (b.lineStart ?? 0),
  );
}
