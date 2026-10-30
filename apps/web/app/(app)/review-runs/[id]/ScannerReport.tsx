export interface ScannerRunRow {
  tool: string;
  status: 'ok' | 'failed' | 'timeout' | 'skipped' | 'not_installed';
  mandatory: boolean;
  reason: string | null;
  scanner_version: string | null;
  image_digest: string | null;
  ruleset: string | null;
  ruleset_pinned: boolean;
  duration_ms: number | null;
  error: string | null;
  findings_count: number;
}

export interface ScanFindingRow {
  id: string;
  tool: string;
  sources: { tool: string; rule_id: string }[];
  rule_id: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: 'secret' | 'sast' | 'dependency' | 'iac' | 'dockerfile';
  file_path: string;
  line_start: number | null;
  title: string;
  message: string;
  evidence: string | null;
  vuln_id: string | null;
  package_name: string | null;
  installed_version: string | null;
  fixed_version: string | null;
  baseline_status: 'new' | 'preexisting' | 'unknown';
  validation_status: 'confirmed' | 'pending_validation' | 'accepted_exception' | 'false_positive_suspected';
}

export interface AuditCoverage {
  complete: boolean;
  missing: { tool: string; status: string; error: string | null }[];
  technologies: string[];
  suppressions?: Record<string, number>;
  scanner_config_files?: string[];
  new_confirmed_secrets?: number;
  policy_reasons?: string[];
}

const STATUS_LABEL: Record<ScannerRunRow['status'], string> = {
  ok: 'ejecutado',
  failed: 'falló',
  timeout: 'tiempo agotado',
  skipped: 'no aplica',
  not_installed: 'no disponible',
};
const LAYER_STATUS: Record<string, string> = { skipped_budget: 'omitida por presupuesto', not_configured: 'sin agente asignado', failed: 'falló' };
const CATEGORY_LABEL: Record<ScanFindingRow['category'], string> = {
  secret: 'secreto',
  sast: 'código',
  dependency: 'dependencia',
  iac: 'infraestructura',
  dockerfile: 'Dockerfile',
};
const VALIDATION_LABEL: Record<ScanFindingRow['validation_status'], string> = {
  confirmed: 'confirmado',
  pending_validation: 'pendiente de validación',
  accepted_exception: 'excepción aceptada',
  false_positive_suspected: 'posible falso positivo',
};

/** Capa 1 de la auditoría: qué escáneres corrieron (y con qué versión), cuáles NO terminaron, y lo que reportaron. */
export function ScannerReport({
  runs,
  findings,
  coverage,
  stage,
}: {
  runs: ScannerRunRow[] | null;
  findings: ScanFindingRow[] | null;
  coverage: AuditCoverage | null;
  stage: string | null;
}) {
  if (!runs || runs.length === 0) return null;
  const incomplete = coverage ? !coverage.complete : false;
  const newCount = (findings ?? []).filter((f) => f.baseline_status === 'new').length;
  const old = (findings ?? []).length - newCount;

  return (
    <section className="scan" aria-label="Auditoría: capa 1">
      <h1>Auditoría — capa 1: escáneres{stage && stage !== 'completed' ? ` (${stage})` : ''}</h1>

      {incomplete && coverage && (
        <p className="scan-banner scan-banner-bad" role="alert">
          <strong>Auditoría incompleta.</strong> No terminaron verificaciones obligatorias:{' '}
          {coverage.missing
            .map((m) => `${m.tool === 'layer2' ? 'capa 2' : m.tool} (${STATUS_LABEL[m.status as ScannerRunRow['status']] ?? LAYER_STATUS[m.status] ?? m.status})`)
            .join(', ')}
          . Un resultado sin ellas no puede aprobarse automáticamente.
        </p>
      )}
      {(coverage?.policy_reasons ?? [])
        // La cobertura incompleta ya tiene su propio banner rojo arriba.
        .filter((reason) => !reason.startsWith('Auditoría incompleta'))
        .map((reason) => (
        <p key={reason} className="scan-banner scan-banner-warn">{reason}</p>
      ))}
      {coverage && (coverage.scanner_config_files?.length ?? 0) > 0 && (
        <p className="scan-banner scan-banner-warn">
          El repositorio trae archivos que configuran o silencian escáneres ({coverage.scanner_config_files!.join(', ')}): se ignoraron.
        </p>
      )}
      {coverage && Object.keys(coverage.suppressions ?? {}).length > 0 && (
        <p className="scan-banner scan-banner-warn">
          El código trae directivas de supresión que esta herramienta no permite ignorar:{' '}
          {Object.entries(coverage.suppressions!).map(([tool, n]) => `${tool}: ${n}`).join(', ')}.
        </p>
      )}

      <div className="scan-table-wrap">
        <table className="scan-table">
          <thead>
            <tr>
              <th>Herramienta</th>
              <th>Estado</th>
              <th>Versión</th>
              <th>Hallazgos</th>
              <th>Detalle</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.tool}>
                <td>
                  <strong>{r.tool}</strong>
                  {!r.mandatory && r.status !== 'skipped' && <small> (opcional)</small>}
                </td>
                <td>
                  <span className={`scan-status scan-status-${r.status}`}>{STATUS_LABEL[r.status]}</span>
                </td>
                <td className="scan-mono">
                  {r.scanner_version ?? '—'}
                  {r.image_digest && <small title={r.image_digest}> {r.image_digest.replace('sha256:', '').slice(0, 8)}</small>}
                </td>
                <td>{r.status === 'ok' ? r.findings_count : '—'}</td>
                <td>
                  {r.error ?? r.reason ?? ''}
                  {r.status === 'ok' && r.ruleset && (
                    <small className="scan-note">
                      {' '}
                      Reglas: {r.ruleset}
                      {r.ruleset_pinned ? '' : ' (no fijadas: cambian con el tiempo)'}.
                    </small>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(findings ?? []).length === 0 ? (
        <p className="scan-note">
          {incomplete ? 'Sin hallazgos de los escáneres que sí terminaron (no es un resultado limpio: faltan escáneres).' : 'Los escáneres no reportaron hallazgos.'}
        </p>
      ) : (
        <>
          <p className="scan-note">
            {newCount} nuevo{newCount === 1 ? '' : 's'} en este cambio · {old} preexistente{old === 1 ? '' : 's'}.
          </p>
          <ul className="scan-list">
            {findings!.map((f) => (
              <li key={f.id} className={`scan-item scan-sev-${f.severity}`}>
                <div className="scan-item-head">
                  <span className={`badge badge-${f.severity === 'critical' || f.severity === 'high' ? 'high' : f.severity === 'medium' ? 'medium' : 'low'}`}>
                    {f.severity.toUpperCase()}
                  </span>
                  <strong>{f.title}</strong>
                  <span className={`scan-tag ${f.baseline_status === 'new' ? 'scan-tag-new' : ''}`}>
                    {f.baseline_status === 'new' ? 'nuevo' : f.baseline_status === 'preexisting' ? 'preexistente' : 'origen desconocido'}
                  </span>
                  <span className="scan-tag">{CATEGORY_LABEL[f.category]}</span>
                  <span className="scan-tag">{VALIDATION_LABEL[f.validation_status]}</span>
                </div>
                <div className="scan-where">
                  {f.file_path}
                  {f.line_start ? `:${f.line_start}` : ''} · {f.sources.map((s) => `${s.tool}/${s.rule_id}`).join(' + ')}
                </div>
                <p>{f.message}</p>
                {f.package_name && (
                  <p className="scan-note">
                    {f.package_name} {f.installed_version}
                    {f.fixed_version ? ` → corregido en ${f.fixed_version}` : ' (sin versión corregida publicada)'}
                  </p>
                )}
                {f.evidence && <pre className="scan-evidence">{f.evidence}</pre>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
