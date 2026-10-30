import type { RawFinding, Severity } from './types';

/** Parsers puros de la salida JSON de cada escáner. Lanzan Error si la salida no es interpretable: un escáner cuya
 * salida no se puede leer es un escáner fallido, nunca un resultado limpio. */

export interface ParsedScan {
  findings: RawFinding[];
  /** Versión que reporta la propia herramienta, cuando la salida la trae. */
  version?: string;
}

interface Ctx {
  checkoutPath: string;
}

export function relativize(path: string, ctx: Ctx): string {
  let p = String(path ?? '').split('\\').join('/');
  const root = ctx.checkoutPath.split('\\').join('/').replace(/\/+$/, '');
  if (p.startsWith(`${root}/`)) p = p.slice(root.length + 1);
  return p.replace(/^\.\//, '').replace(/^\/+/, '');
}

function parseJson(stdout: string, tool: string): unknown {
  const text = stdout.trim();
  if (!text) throw new Error(`${tool} no produjo salida`);
  try {
    return JSON.parse(text);
  } catch {
    // Algunas herramientas escriben avisos antes del JSON: se busca el primer objeto/arreglo completo.
    const start = text.search(/[[{]/);
    if (start > 0) {
      try {
        return JSON.parse(text.slice(start));
      } catch {
        // cae al error de abajo
      }
    }
    throw new Error(`la salida de ${tool} no es JSON válido`);
  }
}

const SECRET_RULE = /(secret|credential|password|passwd|api[-_ ]?key|token|private[-_ ]?key|hardcoded)/i;

export function parseSemgrep(stdout: string, ctx: Ctx): ParsedScan {
  const json = parseJson(stdout, 'semgrep') as { version?: string; results?: any[] };
  if (!json || typeof json !== 'object' || !Array.isArray(json.results)) throw new Error('semgrep: falta la lista de resultados');
  const severityOf = (s: string): Severity => (s === 'ERROR' ? 'high' : s === 'WARNING' ? 'medium' : 'low');
  const findings = json.results.map((r): RawFinding => {
    const ruleId = String(r.check_id ?? 'semgrep');
    const shortRule = ruleId.split('.').pop() ?? ruleId;
    const cwe = Array.isArray(r.extra?.metadata?.cwe) ? r.extra.metadata.cwe[0] : r.extra?.metadata?.cwe;
    const isSecret = SECRET_RULE.test(ruleId) || /secret/i.test(String(r.extra?.metadata?.category ?? ''));
    // En ejecución anónima Semgrep devuelve "requires login" en lugar del código: se ignora y se lee del repo.
    const lines = typeof r.extra?.lines === 'string' && !/requires login/i.test(r.extra.lines) ? r.extra.lines : undefined;
    return {
      tool: 'semgrep',
      ruleId,
      severity: isSecret ? 'critical' : severityOf(String(r.extra?.severity ?? 'WARNING')),
      category: isSecret ? 'secret' : 'sast',
      filePath: relativize(r.path, ctx),
      lineStart: r.start?.line,
      lineEnd: r.end?.line,
      title: shortRule.replace(/[-_]/g, ' '),
      message: String(r.extra?.message ?? ruleId).slice(0, 1000),
      snippet: isSecret ? undefined : lines,
      cwe: cwe ? String(cwe).split(':')[0] : undefined,
      validation: 'pending_validation',
    };
  });
  return { findings, version: json.version };
}

export function parseGitleaks(stdout: string, ctx: Ctx): ParsedScan {
  const json = parseJson(stdout, 'gitleaks');
  if (!Array.isArray(json)) throw new Error('gitleaks: se esperaba una lista de hallazgos');
  const findings = json.map((r: any): RawFinding => ({
    tool: 'gitleaks',
    ruleId: String(r.RuleID ?? 'gitleaks'),
    severity: 'critical',
    category: 'secret',
    filePath: relativize(r.File, ctx),
    lineStart: r.StartLine,
    lineEnd: r.EndLine,
    title: `Posible secreto expuesto (${r.RuleID ?? 'gitleaks'})`,
    message: String(r.Description ?? 'Credencial o token expuesto en el código').slice(0, 500),
    // Nunca el valor: ni Match ni Secret. Gitleaks se ejecuta con --redact y aun así no se usan.
    snippet: undefined,
    validation: 'confirmed',
  }));
  return { findings };
}

export function parseTrivy(stdout: string, ctx: Ctx): ParsedScan {
  const json = parseJson(stdout, 'trivy') as { Results?: any[] | null; SchemaVersion?: number };
  if (!json || typeof json !== 'object' || !('SchemaVersion' in json)) throw new Error('trivy: la salida no tiene el formato esperado');
  const severityOf = (s: string): Severity =>
    s === 'CRITICAL' ? 'critical' : s === 'HIGH' ? 'high' : s === 'MEDIUM' ? 'medium' : s === 'LOW' ? 'low' : 'info';
  const findings: RawFinding[] = [];
  for (const result of json.Results ?? []) {
    for (const v of result.Vulnerabilities ?? []) {
      findings.push({
        tool: 'trivy',
        ruleId: String(v.VulnerabilityID),
        severity: severityOf(String(v.Severity)),
        category: 'dependency',
        filePath: relativize(result.Target, ctx),
        title: `${v.PkgName} ${v.InstalledVersion}: ${v.VulnerabilityID}`,
        message: String(v.Title ?? v.Description ?? v.VulnerabilityID).slice(0, 500),
        vulnId: String(v.VulnerabilityID),
        packageName: String(v.PkgName),
        installedVersion: String(v.InstalledVersion ?? ''),
        fixedVersion: v.FixedVersion ? String(v.FixedVersion) : undefined,
        validation: 'confirmed',
      });
    }
  }
  return { findings };
}

export function parseCheckov(stdout: string, ctx: Ctx): ParsedScan {
  const json = parseJson(stdout, 'checkov');
  const reports: any[] = Array.isArray(json) ? json : [json];
  const findings: RawFinding[] = [];
  let recognised = false;
  let version: string | undefined;
  for (const report of reports) {
    if (!report || typeof report !== 'object') continue;
    if ((report.results && typeof report.results === 'object') || report.summary) recognised = true;
    version ??= report.summary?.checkov_version;
    for (const check of report.results?.failed_checks ?? []) {
      const range: number[] = Array.isArray(check.file_line_range) ? check.file_line_range : [];
      const code = Array.isArray(check.code_block) ? check.code_block.map((l: [number, string]) => l[1]).join('') : undefined;
      findings.push({
        tool: 'checkov',
        ruleId: String(check.check_id),
        // Checkov OSS no siempre trae severidad: sin ella se asume 'medium'.
        severity: ((): Severity => {
          const s = String(check.severity ?? '').toUpperCase();
          return s === 'CRITICAL' ? 'critical' : s === 'HIGH' ? 'high' : s === 'LOW' ? 'low' : s === 'INFO' ? 'info' : 'medium';
        })(),
        category: 'iac',
        filePath: relativize(check.file_path, ctx),
        lineStart: range[0] && range[0] > 0 ? range[0] : undefined,
        lineEnd: range[1] && range[1] > 0 ? range[1] : undefined,
        title: String(check.check_name ?? check.check_id).slice(0, 200),
        message: `${check.check_name ?? check.check_id}${check.resource ? ` (recurso ${check.resource})` : ''}${check.guideline ? ` — ${check.guideline}` : ''}`.slice(0, 600),
        snippet: code,
        validation: 'confirmed',
      });
    }
  }
  // Sin ningún informe con "results" o "summary" (p. ej. un mensaje de error) no se puede afirmar que el análisis se hizo.
  if (!recognised) throw new Error('checkov: la salida no tiene el formato esperado');
  return { findings, version };
}

export function parseHadolint(stdout: string, ctx: Ctx): ParsedScan {
  const json = parseJson(stdout, 'hadolint');
  if (!Array.isArray(json)) throw new Error('hadolint: se esperaba una lista de hallazgos');
  const severityOf = (level: string): Severity => (level === 'error' ? 'medium' : level === 'warning' ? 'low' : 'info');
  const findings = json.map((r: any): RawFinding => ({
    tool: 'hadolint',
    ruleId: String(r.code),
    severity: severityOf(String(r.level)),
    category: 'dockerfile',
    filePath: relativize(r.file, ctx),
    lineStart: r.line,
    lineEnd: r.line,
    title: `${r.code}: ${String(r.message).slice(0, 120)}`,
    message: String(r.message).slice(0, 500),
    validation: 'confirmed',
  }));
  return { findings };
}
