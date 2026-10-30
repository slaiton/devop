export const SCANNER_TOOLS = ['semgrep', 'gitleaks', 'trivy', 'checkov', 'hadolint'] as const;
export type ScannerTool = (typeof SCANNER_TOOLS)[number];

/** ok = corrió y su salida se interpretó. failed / timeout / not_installed NO son "sin hallazgos": son una auditoría
 * incompleta. skipped = la herramienta no aplica a este repositorio (se guarda el motivo). */
export type ScannerStatus = 'ok' | 'failed' | 'timeout' | 'skipped' | 'not_installed';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type FindingCategory = 'secret' | 'sast' | 'dependency' | 'iac' | 'dockerfile';
export type BaselineStatus = 'new' | 'preexisting' | 'unknown';
export type ValidationStatus = 'confirmed' | 'pending_validation' | 'accepted_exception' | 'false_positive_suspected';

/** Lo que devuelve el parser de cada herramienta, antes de normalizar. Las rutas ya son relativas al repo. */
export interface RawFinding {
  tool: ScannerTool;
  ruleId: string;
  severity: Severity;
  category: FindingCategory;
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
  title: string;
  message: string;
  /** Solo para el fingerprint y para citar la evidencia; nunca se guarda tal cual (se redacta). */
  snippet?: string;
  vulnId?: string;
  cwe?: string;
  packageName?: string;
  installedVersion?: string;
  fixedVersion?: string;
  /** Las reglas de Gitleaks son coincidencias exactas de formato; las de Semgrep son patrones que requieren triaje. */
  validation: ValidationStatus;
}

export interface NormalizedFinding extends Omit<RawFinding, 'snippet'> {
  evidence: string | null;
  fingerprint: string;
  baseline: BaselineStatus;
  /** Herramientas que reportaron lo mismo (tras deduplicar). La primera es la principal. */
  sources: { tool: ScannerTool; ruleId: string }[];
}

export interface ScannerRun {
  tool: ScannerTool;
  status: ScannerStatus;
  mandatory: boolean;
  reason: string | null;
  scannerVersion: string | null;
  image: string | null;
  imageDigest: string | null;
  ruleset: string | null;
  rulesetPinned: boolean;
  durationMs: number | null;
  exitCode: number | null;
  error: string | null;
  findingsCount: number;
}

export interface Layer1Coverage {
  /** false si algún escáner obligatorio y aplicable no terminó bien. */
  complete: boolean;
  /** Herramientas obligatorias y aplicables que no corrieron bien (con el motivo). */
  missing: { tool: ScannerTool; status: ScannerStatus; error: string | null }[];
  technologies: string[];
  /** Directivas de supresión que trae el repo, por herramienta (para las que no se pueden ejecutar ignorándolas). */
  suppressions?: Record<string, number>;
  /** Archivos con los que el repo intentó configurar o silenciar escáneres: se ignoran. */
  scannerConfigFiles?: string[];
}

export interface Layer1Result {
  runs: ScannerRun[];
  findings: NormalizedFinding[];
  coverage: Layer1Coverage;
}

/** Tecnologías detectadas en el checkout: deciden qué escáneres aplican. Nada se ejecuta "por si acaso". */
export interface RepoTechnologies {
  dockerfiles: string[];
  terraform: boolean;
  terraformFiles: string[];
  /** CloudFormation, manifiestos de Kubernetes, charts de Helm y workflows de GitHub Actions. */
  iacFiles: string[];
  lockfiles: string[];
  sourceFiles: number;
  languages: string[];
  /** Archivos con los que un repo configura o silencia escáneres (.semgrepignore, .trivyignore, .gitleaks.toml…). Se avisan
   * y se neutralizan: el repo auditado no puede cambiar las reglas de la auditoría. */
  scannerConfigFiles: string[];
}
