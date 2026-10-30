import type { ParsedScan } from './parsers';
import { parseCheckov, parseGitleaks, parseHadolint, parseSemgrep, parseTrivy } from './parsers';
import type { RepoTechnologies, ScannerTool } from './types';

/** Versiones controladas: cada escáner se ejecuta por DIGEST (no por `latest`), así dos auditorías del mismo commit usan
 * exactamente la misma herramienta. Para actualizar: probar la nueva imagen y cambiar el digest aquí, o definir
 * AUDIT_IMAGE_<HERRAMIENTA> en el entorno (queda registrado en cada auditoría). */
const DEFAULT_IMAGES: Record<ScannerTool, { image: string; version: string }> = {
  semgrep: { image: 'semgrep/semgrep@sha256:451b3d875c00dac7ed5db5293e584a07de11449a409c10b3c2d2652f429630b6', version: '1.182.1' },
  gitleaks: { image: 'zricethezav/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f', version: '8.30.1' },
  trivy: { image: 'aquasec/trivy@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c', version: '0.76.1' },
  checkov: { image: 'bridgecrew/checkov@sha256:ece5efac4443084ca273072909985dce988a81e8cc94faa305aeda0df27c68f9', version: '3.4.0' },
  hadolint: { image: 'hadolint/hadolint@sha256:32dac94127fd60b7b7e3fbfc65e1383b9b5e25c9bfd7b8536de7a539fe68a12d', version: '2.15.1' },
};

export interface ScannerPlan {
  cmd: string[];
  entrypoint?: string[];
  env?: Record<string, string>;
  /** Escribe en caché persistente (p. ej. la base de vulnerabilidades de Trivy). */
  cacheVolume?: { name: string; target: string };
  /** Usuario con el que corre; por defecto no-root. Trivy necesita escribir en su caché. */
  user?: string;
}

export interface ScannerDef {
  tool: ScannerTool;
  label: string;
  /** Obligatorio cuando aplica: si no corre bien, la auditoría queda incompleta. */
  mandatory: boolean;
  network: boolean;
  timeoutMs: number;
  memoryMb: number;
  okExitCodes: number[];
  /** De dónde salen las reglas y si están fijadas. Las reglas del registro de Semgrep y la base de Trivy cambian con el tiempo. */
  ruleset: string | null;
  rulesetPinned: boolean;
  applies(tech: RepoTechnologies): { applies: boolean; reason: string };
  /** `target` es la ruta ABSOLUTA del checkout dentro del contenedor (el trabajo corre desde /tmp, no desde el repo). */
  plan(target: string, tech: RepoTechnologies): ScannerPlan;
  parse(stdout: string, ctx: { checkoutPath: string }): ParsedScan;
}

export function imageFor(tool: ScannerTool): { image: string; version: string | null } {
  const override = process.env[`AUDIT_IMAGE_${tool.toUpperCase()}`]?.trim();
  if (override) return { image: override, version: null };
  return { image: DEFAULT_IMAGES[tool].image, version: DEFAULT_IMAGES[tool].version };
}

const SEMGREP_CONFIGS = (process.env.AUDIT_SEMGREP_CONFIGS?.split(',').map((s) => s.trim()).filter(Boolean) ?? ['p/default', 'p/owasp-top-ten']);

/** Las reglas del repo no pueden cambiar la auditoría: se pasa la configuración por entorno/flags (que tienen prioridad
 * sobre los archivos del repo) y se ignoran las directivas de supresión en el código (nosemgrep, gitleaks:allow). */
export const SCANNERS: ScannerDef[] = [
  {
    tool: 'gitleaks',
    label: 'Gitleaks',
    mandatory: true,
    network: false,
    timeoutMs: 120_000,
    memoryMb: 512,
    okExitCodes: [0],
    ruleset: 'reglas por defecto de Gitleaks (integradas en la versión fijada)',
    rulesetPinned: true,
    applies: () => ({ applies: true, reason: 'siempre aplica: busca secretos en todo el repositorio' }),
    plan: (target) => ({
      cmd: [
        'detect', '--no-git', '--source', target, '--report-format', 'json', '--report-path', '-',
        // --redact: el valor del secreto nunca sale del contenedor. -i y GITLEAKS_CONFIG_TOML: el repo no puede traer su
        // propia allowlist ni su .gitleaksignore. --ignore-gitleaks-allow: ignora los comentarios "gitleaks:allow".
        '--redact', '--exit-code', '0', '--no-banner', '--log-level', 'error', '--ignore-gitleaks-allow', '-i', '/nonexistent',
      ],
      env: { GITLEAKS_CONFIG_TOML: '[extend]\nuseDefault = true\n' },
    }),
    parse: parseGitleaks,
  },
  {
    tool: 'semgrep',
    label: 'Semgrep',
    mandatory: true,
    network: true, // descarga las reglas del registro
    timeoutMs: 300_000,
    memoryMb: 2048,
    okExitCodes: [0],
    ruleset: SEMGREP_CONFIGS.join(' + '),
    rulesetPinned: false,
    applies: (tech) =>
      tech.sourceFiles > 0
        ? { applies: true, reason: `código fuente detectado (${tech.languages.filter((l) => l !== 'terraform').join(', ')})` }
        : { applies: false, reason: 'no hay código fuente de un lenguaje soportado' },
    plan: (target) => ({
      cmd: [
        'semgrep', 'scan', ...SEMGREP_CONFIGS.flatMap((c) => ['--config', c]), '--json', '--quiet', '--metrics=off',
        '--disable-version-check', '--disable-nosem', '--max-target-bytes', '1000000', target,
      ],
      env: { SEMGREP_SEND_METRICS: 'off' },
    }),
    parse: parseSemgrep,
  },
  {
    tool: 'trivy',
    label: 'Trivy',
    mandatory: true,
    network: true, // actualiza su base de vulnerabilidades
    timeoutMs: 360_000,
    memoryMb: 1024,
    okExitCodes: [0],
    ruleset: 'base de vulnerabilidades de Trivy (se actualiza en cada ejecución)',
    rulesetPinned: false,
    applies: (tech) =>
      tech.lockfiles.length > 0
        ? { applies: true, reason: `manifiestos de dependencias: ${tech.lockfiles.slice(0, 4).join(', ')}${tech.lockfiles.length > 4 ? '…' : ''}` }
        : { applies: false, reason: 'no hay manifiestos ni lockfiles de dependencias' },
    plan: (target) => ({
      entrypoint: ['trivy'],
      // --scanners vuln: solo dependencias (los secretos son de Gitleaks; Dockerfile e IaC, de Hadolint y Checkov).
      // --ignorefile "": el repo no puede traer su .trivyignore.
      cmd: ['fs', '--format', 'json', '--scanners', 'vuln', '--quiet', '--no-progress', '--cache-dir', '/cache', '--ignorefile', '', '--timeout', '5m', target],
      cacheVolume: { name: 'devsentinel_scanner_cache', target: '/cache' },
      // root solo para escribir en el volumen de caché; sin capabilities, rootfs de solo lectura y sin escalada.
      user: '0',
    }),
    parse: parseTrivy,
  },
  {
    tool: 'checkov',
    label: 'Checkov',
    mandatory: true,
    network: false,
    timeoutMs: 300_000,
    memoryMb: 1024,
    okExitCodes: [0],
    ruleset: 'políticas integradas en Checkov (sin descarga: --skip-download)',
    rulesetPinned: true,
    applies: (tech) =>
      tech.terraform || tech.iacFiles.length > 0
        ? { applies: true, reason: tech.terraform ? 'Terraform detectado' : `infraestructura como código: ${tech.iacFiles.slice(0, 3).join(', ')}` }
        : { applies: false, reason: 'no hay Terraform, CloudFormation, Kubernetes, Helm ni workflows de GitHub Actions' },
    plan: (target) => ({
      entrypoint: ['checkov'],
      // Solo los marcos de IaC; los secretos (Gitleaks), el Dockerfile (Hadolint) y las dependencias (Trivy) no se repiten.
      cmd: ['-d', target, '--output', 'json', '--quiet', '--compact', '--soft-fail', '--skip-download', '--framework', 'terraform,terraform_json,cloudformation,kubernetes,helm,github_actions,serverless'],
    }),
    parse: parseCheckov,
  },
  {
    tool: 'hadolint',
    label: 'Hadolint',
    mandatory: true,
    network: false,
    timeoutMs: 60_000,
    memoryMb: 256,
    okExitCodes: [0],
    ruleset: 'reglas integradas en Hadolint',
    rulesetPinned: true,
    applies: (tech) =>
      tech.dockerfiles.length > 0
        ? { applies: true, reason: `Dockerfiles: ${tech.dockerfiles.slice(0, 4).join(', ')}${tech.dockerfiles.length > 4 ? '…' : ''}` }
        : { applies: false, reason: 'no hay Dockerfiles' },
    plan: (target, tech) => ({
      cmd: ['hadolint', '--format', 'json', '--no-fail', ...tech.dockerfiles.map((f) => `${target}/${f}`)],
    }),
    parse: parseHadolint,
  },
];
