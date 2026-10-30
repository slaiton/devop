import { open, readdir } from 'fs/promises';
import { join, relative } from 'path';
import type { RepoTechnologies } from './types';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', '.next', 'target', '.terraform', '__pycache__', '.venv', 'venv', '.gradle', 'Pods']);
const MAX_ENTRIES = 30_000;
const MAX_DEPTH = 10;
const MAX_IAC_PROBES = 300;

const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.lock', 'Gemfile.lock', 'go.mod', 'go.sum',
  'requirements.txt', 'Pipfile.lock', 'poetry.lock', 'uv.lock', 'pom.xml', 'gradle.lockfile', 'Cargo.lock', 'packages.lock.json',
  'mix.lock', 'pubspec.lock', 'Podfile.lock',
]);

export const SCANNER_CONFIG_FILES = new Set([
  '.semgrepignore', '.gitleaks.toml', '.gitleaksignore', '.trivyignore', '.trivyignore.yaml', '.hadolint.yaml', '.hadolint.yml',
  '.checkov.yaml', '.checkov.yml', '.checkov.baseline',
]);

const LANGUAGE_BY_EXT: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', php: 'php', java: 'java', kt: 'kotlin', go: 'go', rb: 'ruby', cs: 'csharp', rs: 'rust',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', swift: 'swift', scala: 'scala', tf: 'terraform',
};

export function isDockerfileName(name: string): boolean {
  return /^(dockerfile|containerfile)(\.[\w.-]+)?$/i.test(name) || /\.(dockerfile|containerfile)$/i.test(name);
}

async function head(path: string, bytes: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** ¿Este YAML/JSON es infraestructura como código? CloudFormation, un manifiesto de Kubernetes, un chart de Helm o un
 * workflow de GitHub Actions. Mira solo los primeros bytes: no ejecuta ni interpreta nada del repo. */
async function looksLikeIac(path: string, relPath: string): Promise<boolean> {
  if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i.test(relPath)) return true;
  if (/(^|\/)Chart\.ya?ml$/i.test(relPath)) return true;
  try {
    const text = await head(path, 2048);
    if (/AWSTemplateFormatVersion/.test(text) || /"?Transform"?\s*:\s*"?AWS::Serverless/.test(text)) return true;
    return /^apiVersion:\s*\S+/m.test(text) && /^kind:\s*\S+/m.test(text);
  } catch {
    return false;
  }
}

/** Recorre el checkout (acotado) y dice qué tecnologías hay. Los escáneres aplicables salen de aquí. */
export async function detectTechnologies(checkoutPath: string): Promise<RepoTechnologies> {
  const tech: RepoTechnologies = { dockerfiles: [], terraform: false, terraformFiles: [], iacFiles: [], lockfiles: [], sourceFiles: 0, languages: [], scannerConfigFiles: [] };
  const languages = new Set<string>();
  const yamlCandidates: string[] = [];
  let visited = 0;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || visited > MAX_ENTRIES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++visited > MAX_ENTRIES) return;
      if (entry.isSymbolicLink()) continue; // nunca se sigue un symlink fuera del repo
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(checkoutPath, full).split('\\').join('/');
      const name = entry.name;
      if (isDockerfileName(name)) tech.dockerfiles.push(rel);
      if (LOCKFILES.has(name)) tech.lockfiles.push(rel);
      if (SCANNER_CONFIG_FILES.has(name)) tech.scannerConfigFiles.push(rel);
      if (/\.tf(\.json)?$/i.test(name)) {
        tech.terraform = true;
        tech.terraformFiles.push(rel);
        languages.add('terraform');
      }
      if (/\.ya?ml$/i.test(name) || /\.json$/i.test(name)) yamlCandidates.push(rel);
      const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
      const language = LANGUAGE_BY_EXT[ext];
      if (language && language !== 'terraform') {
        tech.sourceFiles += 1;
        languages.add(language);
      }
    }
  }

  await walk(checkoutPath, 0);

  // Los workflows y los charts primero; el resto, hasta el tope de sondeos.
  yamlCandidates.sort((a, b) => Number(/\.github\/workflows|Chart\.ya?ml/i.test(b)) - Number(/\.github\/workflows|Chart\.ya?ml/i.test(a)));
  for (const rel of yamlCandidates.slice(0, MAX_IAC_PROBES)) {
    if (await looksLikeIac(join(checkoutPath, rel), rel)) tech.iacFiles.push(rel);
  }

  tech.languages = [...languages].sort();
  return tech;
}

export function describeTechnologies(tech: RepoTechnologies): string[] {
  const out = [...tech.languages];
  if (tech.dockerfiles.length) out.push('docker');
  if (tech.lockfiles.length) out.push('dependencias');
  if (tech.iacFiles.length && !tech.terraform) out.push('iac');
  return [...new Set(out)];
}
