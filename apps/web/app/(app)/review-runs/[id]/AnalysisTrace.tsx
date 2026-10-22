export interface TraceEntry {
  round: number;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
  chars: number;
  ms: number;
}

export interface AnalysisStats {
  rounds: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  budgetExhausted: boolean;
}

const TOOL_LABEL: Record<string, string> = {
  read_file: 'Leyó',
  search_code: 'Buscó en el código',
  list_dir: 'Listó la carpeta',
  find_files: 'Buscó archivos',
  file_history: 'Historial de',
  show_commit: 'Revisó el commit',
  blame: 'Blame de',
  semantic_search: 'Búsqueda semántica',
  read_remote_file: 'Leyó en GitHub',
  get_pull_request_context: 'Contexto del Pull Request',
};

/** El argumento que mejor describe la consulta ("src/a.ts", "findByEmail"…). */
function describeArgs(args: Record<string, unknown>): string {
  // Archivo de otro repo: "repo:ruta@rama"
  if (typeof args.repo === 'string' && typeof args.path === 'string') {
    return `${args.repo}:${args.path}${typeof args.ref === 'string' ? `@${args.ref}` : ''}`;
  }
  const pick = ['path', 'pattern', 'glob', 'sha', 'query', 'repo'].flatMap((k) => (typeof args[k] === 'string' ? [String(args[k])] : []));
  const range = typeof args.start_line === 'number' ? `:${args.start_line}${typeof args.end_line === 'number' ? `-${args.end_line}` : ''}` : '';
  const ref = typeof args.ref === 'string' ? `@${args.ref}` : '';
  return pick.length ? `${pick.join(' · ')}${range}${ref}` : '';
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Cómo se analizó el commit: modo, consumo y, en el modo profundo, qué consultó el revisor antes de opinar. */
export function AnalysisTrace({
  mode,
  note,
  trace,
  stats,
}: {
  mode: 'standard' | 'deep' | null;
  note: string | null;
  trace: TraceEntry[] | null;
  stats: AnalysisStats | null;
}) {
  if (!mode) return null; // revisiones anteriores a que se guardara el modo

  return (
    <section className="trace-card" aria-label="Cómo se analizó este commit">
      <div className="trace-head">
        <span className={`trace-mode trace-mode-${mode}`}>{mode === 'deep' ? 'Análisis profundo' : 'Análisis estándar'}</span>
        {stats && (
          <span className="trace-stats">
            {stats.rounds} ronda{stats.rounds === 1 ? '' : 's'} · {stats.toolCalls} consulta{stats.toolCalls === 1 ? '' : 's'} ·{' '}
            {formatTokens(stats.promptTokens + stats.completionTokens)} tokens · {Math.max(1, Math.round(stats.durationMs / 1000))} s
          </span>
        )}
      </div>
      {note && <p className="status-warn trace-note">{note}</p>}
      {trace && trace.length > 0 && (
        <details>
          <summary>Qué revisó la IA antes de opinar ({trace.length} consulta{trace.length === 1 ? '' : 's'})</summary>
          <ol className="trace-list">
            {trace.map((t, i) => (
              <li key={i} className={t.ok ? '' : 'trace-failed'}>
                <span className="trace-round">ronda {t.round}</span>
                <strong>{TOOL_LABEL[t.tool] ?? t.tool}</strong> <code>{describeArgs(t.args)}</code>
                <span className="trace-result">{t.ok ? '' : '✕ '}{t.summary}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
