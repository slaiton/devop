import { execFile } from 'child_process';
import { open, readdir, realpath, stat } from 'fs/promises';
import { join, posix, sep } from 'path';
import { promisify } from 'util';
import type { GitProviderPort } from '@devsentinel/git-providers';
import type { AgentToolbox, AgentToolDefinition, AgentToolResult } from '@devsentinel/llm-port';

const execFileAsync = promisify(execFile);

/** Tope de lo que devuelve UNA consulta (el presupuesto total lo lleva el bucle del LLM). */
const MAX_CALL_CHARS = 20_000;
const MAX_FILE_BYTES = 1_500_000;
const MAX_READ_LINES = 500;
const MAX_SEARCH_LINES = 100;
const MAX_LIST_ENTRIES = 200;
const GIT_TIMEOUT_MS = 20_000;

const EXAMPLE_ENV = /\.(example|sample|template|dist)$/i;

/** Archivos que el revisor nunca debe leer aunque estén en el repo o en el directorio de trabajo:
 * el directorio .git (su config trae el token de la instalación si el clon lo dejó en la URL),
 * archivos de entorno y llaves, y los informes que genera el análisis estático (traen los
 * secretos detectados en claro). Lo que lee el revisor viaja al proveedor del LLM. */
export function isDeniedPath(relPath: string): boolean {
  const segments = relPath.split(/[\\/]+/).filter(Boolean);
  if (segments.some((s) => s.toLowerCase() === '.git')) return true;
  const base = segments[segments.length - 1] ?? '';
  if (/^\.env/i.test(base) && !EXAMPLE_ENV.test(base)) return true;
  if (/^\.(npmrc|netrc|pypirc|git-credentials|htpasswd)$/i.test(base)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i.test(base)) return true;
  if (/\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk)$/i.test(base)) return true;
  if (/^(secrets?|credentials?)\.(json|ya?ml|toml|txt|env)$/i.test(base)) return true;
  if (/^\.gitleaks/i.test(base)) return true;
  return false;
}

export function cap(text: string, max = MAX_CALL_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n[...recortado: ${text.length - max} caracteres más]` : text;
}

export function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function int(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined;
}

export const fail = (message: string): AgentToolResult => ({ output: `Error: ${message}`, summary: message, ok: false });
export const done = (output: string, summary: string): AgentToolResult => ({ output, summary, ok: true });

/** Normaliza una ruta relativa que pide el modelo; rechaza absolutas, `..`, magia de pathspec y secretos. */
export function cleanRelPath(raw: string | undefined, { allowEmpty = false } = {}): string {
  if (raw === undefined || raw.trim() === '' || raw.trim() === '.' || raw.trim() === './') {
    if (allowEmpty) return '';
    throw new Error('falta la ruta');
  }
  if (raw.includes('\0') || raw.length > 400) throw new Error('ruta inválida');
  if (raw.startsWith(':')) throw new Error('ruta inválida');
  const normalized = posix.normalize(raw.replace(/\\/g, '/').replace(/^\.\//, ''));
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) throw new Error('solo se aceptan rutas relativas a la raíz del repo');
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) throw new Error('la ruta sale del repositorio');
  if (isDeniedPath(normalized)) throw new Error('esa ruta está protegida (no se pueden leer secretos ni el directorio .git)');
  return normalized === '.' ? '' : normalized.replace(/\/+$/, '');
}

function isLikelyBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

/** Quita de la salida de `git show -p` las secciones de archivos protegidos. */
function filterDiffSections(diff: string): string {
  const parts = diff.split(/^(?=diff --git )/m);
  return parts
    .filter((part) => {
      const m = part.match(/^diff --git a\/(.+?) b\//);
      return !m || !isDeniedPath(m[1]);
    })
    .join('');
}

export interface ToolboxDeps {
  /** Directorio del clon en el commit analizado. */
  checkoutPath: string;
  git: GitProviderPort;
  installationId: number;
  owner: string;
  repo: string;
  commitSha: string;
  pullNumber?: number;
  /** Búsqueda semántica sobre el índice de código del repo (opcional). */
  semanticSearch?: (query: string) => Promise<{ filePath: string; content: string }[]>;
}

const DEFS: AgentToolDefinition[] = [
  {
    name: 'read_file',
    description:
      'Lee un archivo del repositorio en el commit analizado, con números de línea. Úsalo para ver el contexto completo de lo que cambió: contratos, interfaces, migraciones, configuración, tests. Para archivos grandes pide un rango con start_line/end_line.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta relativa a la raíz del repo, p. ej. src/users/users.service.ts' },
        start_line: { type: 'integer', description: 'Primera línea a leer (desde 1). Opcional.' },
        end_line: { type: 'integer', description: 'Última línea a leer. Opcional (máximo 500 líneas por consulta).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_code',
    description:
      'Busca texto o una expresión regular en todo el código versionado (git grep). Sirve para encontrar dónde se usa una función, clase, constante, tabla o endpoint, y quién llama a lo que cambió.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Texto o regex extendida a buscar.' },
        literal: { type: 'boolean', description: 'true = buscar el texto literal (sin regex). Por defecto false.' },
        ignore_case: { type: 'boolean', description: 'Ignorar mayúsculas/minúsculas. Por defecto false.' },
        path: { type: 'string', description: 'Limitar la búsqueda a esta carpeta o archivo. Opcional.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'list_dir',
    description: 'Lista el contenido de una carpeta del repo (omite .git y archivos protegidos). Sin path lista la raíz.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Carpeta relativa a la raíz. Opcional.' } } },
  },
  {
    name: 'find_files',
    description: 'Encuentra archivos versionados por patrón glob, p. ej. "*.spec.ts", "src/**/auth*", "migrations/*.sql".',
    parameters: {
      type: 'object',
      properties: { glob: { type: 'string', description: 'Patrón glob. Sin "/" se busca en cualquier carpeta.' } },
      required: ['glob'],
    },
  },
  {
    name: 'file_history',
    description:
      'Historial de commits de un archivo (sigue renombrados): hash, fecha, autor y mensaje. Úsalo para entender por qué el archivo está como está y si ya hubo cambios o correcciones parecidas.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Archivo a consultar.' },
        limit: { type: 'integer', description: 'Cantidad de commits (por defecto 8, máximo 20).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'show_commit',
    description:
      'Muestra un commit del historial: autor, fecha, mensaje y archivos tocados; con include_diff=true también su diff (recortado). Úsalo para leer un commit previo que parezca relacionado.',
    parameters: {
      type: 'object',
      properties: {
        sha: { type: 'string', description: 'Hash del commit (7 a 40 caracteres hexadecimales).' },
        include_diff: { type: 'boolean', description: 'Incluir el diff. Por defecto false.' },
      },
      required: ['sha'],
    },
  },
  {
    name: 'blame',
    description: 'Quién escribió cada línea de un rango (commit, autor, fecha). Útil para ver si el código que se toca es antiguo o reciente y de quién.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        start_line: { type: 'integer' },
        end_line: { type: 'integer', description: 'Máximo 80 líneas por consulta.' },
      },
      required: ['path', 'start_line', 'end_line'],
    },
  },
  {
    name: 'semantic_search',
    description:
      'Búsqueda por significado sobre el código ya indexado del repo (no por texto exacto): sirve para encontrar código parecido o duplicado. Cubre solo lo indexado hasta ahora.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Descripción o fragmento de lo que buscas.' } },
      required: ['query'],
    },
  },
  {
    name: 'read_remote_file',
    description:
      'Lee un archivo (o lista una carpeta) vía la API de GitHub. Sin "repo" es este mismo repositorio; con "repo" puedes leer otro repositorio de la misma instalación (p. ej. una librería o servicio del que depende). Con "ref" eliges rama, tag o commit; sin ref es la rama por defecto (útil para comparar con lo que hay hoy en producción).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        repo: { type: 'string', description: 'Opcional: "owner/nombre" o solo "nombre" (mismo owner).' },
        ref: { type: 'string', description: 'Opcional: rama, tag o SHA.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'get_pull_request_context',
    description: 'Título, descripción, etiquetas y primeros comentarios del Pull Request relacionado con este commit: el "porqué" del cambio.',
    parameters: { type: 'object', properties: {} },
  },
];

/** Herramientas de solo lectura que el revisor puede usar en el análisis profundo. Todo corre contra el
 * clon del commit (sin shell: `execFile` con argumentos fijos) salvo las dos que consultan la API de
 * GitHub. Las rutas se validan contra escapes (`..`, symlinks, `.git`, secretos). */
export class ReviewToolbox implements AgentToolbox {
  readonly definitions = DEFS;
  private rootReal: string | null = null;

  constructor(private readonly deps: ToolboxDeps) {}

  async execute(name: string, args: Record<string, unknown>): Promise<AgentToolResult> {
    try {
      switch (name) {
        case 'read_file':
          return await this.readFile(args);
        case 'search_code':
          return await this.searchCode(args);
        case 'list_dir':
          return await this.listDir(args);
        case 'find_files':
          return await this.findFiles(args);
        case 'file_history':
          return await this.fileHistory(args);
        case 'show_commit':
          return await this.showCommit(args);
        case 'blame':
          return await this.blame(args);
        case 'semantic_search':
          return await this.semanticSearch(args);
        case 'read_remote_file':
          return await this.readRemoteFile(args);
        case 'get_pull_request_context':
          return await this.pullRequestContext();
        default:
          return fail(`herramienta desconocida "${name}"`);
      }
    } catch (err) {
      return fail((err as Error).message.slice(0, 300));
    }
  }

  // ------------------------------------------------------------------ utilidades

  private async git(args: string[], { allowExit1 = false } = {}): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', ['--no-pager', '-c', 'core.quotepath=false', ...args], {
        cwd: this.deps.checkoutPath,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', LC_ALL: 'C.UTF-8' },
      });
      return stdout;
    } catch (err) {
      const e = err as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
      if (allowExit1 && e.code === 1) return e.stdout ?? '';
      if (e.killed) throw new Error('la consulta tardó demasiado y se canceló');
      throw new Error((e.stderr ?? '').trim().split('\n')[0] || 'git falló');
    }
  }

  /** Ruta absoluta dentro del clon, resolviendo symlinks: nada que apunte fuera del repo. */
  private async resolveInside(rel: string): Promise<string> {
    this.rootReal ??= await realpath(this.deps.checkoutPath);
    let real: string;
    try {
      real = await realpath(join(this.deps.checkoutPath, rel));
    } catch {
      throw new Error(`no existe: ${rel || '.'}`);
    }
    if (real !== this.rootReal && !real.startsWith(this.rootReal + sep)) throw new Error('la ruta sale del repositorio');
    const relReal = real.slice(this.rootReal.length + 1);
    if (relReal && isDeniedPath(relReal)) throw new Error('esa ruta está protegida');
    return real;
  }

  // ------------------------------------------------------------------ herramientas locales

  private async readFile(args: Record<string, unknown>): Promise<AgentToolResult> {
    const rel = cleanRelPath(str(args, 'path'));
    const abs = await this.resolveInside(rel);
    const info = await stat(abs);
    if (info.isDirectory()) return fail(`${rel} es una carpeta: usa list_dir`);
    if (info.size > MAX_FILE_BYTES) return fail(`${rel} pesa ${Math.round(info.size / 1024)} KB: demasiado grande para leerlo (usa search_code para ubicar lo que buscas)`);

    const handle = await open(abs, 'r');
    let buffer: Buffer;
    try {
      buffer = Buffer.alloc(info.size);
      await handle.read(buffer, 0, info.size, 0);
    } finally {
      await handle.close();
    }
    if (isLikelyBinary(buffer)) return fail(`${rel} es un archivo binario`);

    const lines = buffer.toString('utf8').split('\n');
    if (lines[lines.length - 1] === '') lines.pop(); // el salto de línea final no es una línea más
    const start = Math.max(1, int(args, 'start_line') ?? 1);
    const requestedEnd = int(args, 'end_line') ?? start + MAX_READ_LINES - 1;
    const end = Math.min(lines.length, requestedEnd, start + MAX_READ_LINES - 1);
    if (start > lines.length) return fail(`${rel} tiene ${lines.length} líneas`);

    const width = String(end).length;
    const body = lines
      .slice(start - 1, end)
      .map((line, i) => `${String(start + i).padStart(width)}| ${line.length > 400 ? `${line.slice(0, 400)}…` : line}`)
      .join('\n');
    const note = end < lines.length ? `\n[mostrando líneas ${start}-${end} de ${lines.length}; pide otro rango para ver más]` : '';
    return done(cap(`${rel} (${lines.length} líneas)\n${body}${note}`), `${rel} líneas ${start}-${end} de ${lines.length}`);
  }

  private async searchCode(args: Record<string, unknown>): Promise<AgentToolResult> {
    const pattern = str(args, 'pattern');
    if (!pattern) return fail('falta el patrón');
    if (pattern.length > 300 || pattern.includes('\0')) return fail('patrón inválido o demasiado largo');
    const where = cleanRelPath(str(args, 'path'), { allowEmpty: true });
    const flags = [args.literal === true ? '-F' : '-E', ...(args.ignore_case === true ? ['-i'] : [])];
    const out = await this.git(['grep', '-n', '-I', '--no-color', ...flags, '-e', pattern, '--', ...(where ? [where] : [])], { allowExit1: true });

    const matches = out
      .split('\n')
      .filter(Boolean)
      .filter((line) => !isDeniedPath(line.slice(0, line.indexOf(':'))));
    if (matches.length === 0) return done('Sin coincidencias.', 'sin coincidencias');
    const shown = matches.slice(0, MAX_SEARCH_LINES).map((l) => (l.length > 240 ? `${l.slice(0, 240)}…` : l));
    const files = new Set(matches.map((l) => l.slice(0, l.indexOf(':')))).size;
    const more = matches.length > shown.length ? `\n[${matches.length - shown.length} coincidencias más; afina el patrón o limita con path]` : '';
    return done(cap(`${matches.length} coincidencias en ${files} archivos (archivo:línea:texto)\n${shown.join('\n')}${more}`), `${matches.length} coincidencias en ${files} archivos`);
  }

  private async listDir(args: Record<string, unknown>): Promise<AgentToolResult> {
    const rel = cleanRelPath(str(args, 'path'), { allowEmpty: true });
    const abs = await this.resolveInside(rel);
    const entries = (await readdir(abs, { withFileTypes: true }))
      .filter((e) => !isDeniedPath(e.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const shown = entries.slice(0, MAX_LIST_ENTRIES).map((e) => `${e.isDirectory() ? '[dir] ' : ''}${e.name}`);
    const more = entries.length > shown.length ? `\n[${entries.length - shown.length} entradas más]` : '';
    return done(`${rel || '(raíz)'}\n${shown.join('\n')}${more}`, `${entries.length} entradas en ${rel || 'raíz'}`);
  }

  private async findFiles(args: Record<string, unknown>): Promise<AgentToolResult> {
    const glob = str(args, 'glob');
    if (!glob || glob.length > 200 || glob.includes('\0') || glob.startsWith(':')) return fail('glob inválido');
    if (glob.replace(/\\/g, '/').split('/').includes('..')) return fail('glob inválido');
    const spec = glob.includes('/') ? glob : `**/${glob}`;
    const out = await this.git(['ls-files', '-z', '--', `:(glob)${spec}`]);
    const files = out.split('\0').filter(Boolean).filter((f) => !isDeniedPath(f));
    if (files.length === 0) return done('Sin archivos que coincidan.', 'sin resultados');
    const shown = files.slice(0, 100);
    const more = files.length > shown.length ? `\n[${files.length - shown.length} archivos más]` : '';
    return done(`${files.length} archivos\n${shown.join('\n')}${more}`, `${files.length} archivos`);
  }

  private async fileHistory(args: Record<string, unknown>): Promise<AgentToolResult> {
    const rel = cleanRelPath(str(args, 'path'));
    const limit = Math.min(20, Math.max(1, int(args, 'limit') ?? 8));
    const out = await this.git(['log', '--follow', `-n${limit}`, '--date=short', '--format=%h %ad %an: %s', '--', rel]);
    if (!out.trim()) return done('Sin historial para ese archivo (¿es nuevo en este commit?).', 'sin historial');
    return done(cap(`Últimos commits de ${rel}\n${out.trim()}`), `${out.trim().split('\n').length} commits de ${rel}`);
  }

  private async showCommit(args: Record<string, unknown>): Promise<AgentToolResult> {
    const sha = str(args, 'sha');
    if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) return fail('sha inválido (7 a 40 caracteres hexadecimales)');
    const withDiff = args.include_diff === true;
    const out = await this.git([
      'show',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--date=short',
      '--format=commit %H%nAutor: %an%nFecha: %ad%n%n%s%n%n%b',
      ...(withDiff ? ['-p'] : ['--stat=120']),
      sha,
      '--',
    ]);
    const text = withDiff ? filterDiffSections(out) : out;
    return done(cap(text.trim(), withDiff ? 14_000 : 6_000), `commit ${sha.slice(0, 7)}${withDiff ? ' con diff' : ''}`);
  }

  private async blame(args: Record<string, unknown>): Promise<AgentToolResult> {
    const rel = cleanRelPath(str(args, 'path'));
    const start = int(args, 'start_line');
    const end = int(args, 'end_line');
    if (!start || !end || start < 1 || end < start) return fail('rango de líneas inválido');
    const last = Math.min(end, start + 79);
    await this.resolveInside(rel);
    const out = await this.git(['blame', '-w', '--date=short', '-L', `${start},${last}`, '--', rel]);
    const note = last < end ? `\n[rango recortado a 80 líneas (${start}-${last})]` : '';
    return done(cap(out.trim() + note), `blame ${rel}:${start}-${last}`);
  }

  private async semanticSearch(args: Record<string, unknown>): Promise<AgentToolResult> {
    const query = str(args, 'query');
    if (!query) return fail('falta la consulta');
    if (!this.deps.semanticSearch) return fail('la búsqueda semántica no está disponible');
    const chunks = (await this.deps.semanticSearch(query.slice(0, 1500))).filter((c) => !isDeniedPath(c.filePath));
    if (chunks.length === 0) return done('Sin resultados en el índice de código.', 'sin resultados');
    const text = chunks.map((c) => `--- ${c.filePath} ---\n${c.content.slice(0, 3500)}`).join('\n\n');
    return done(cap(text), `${chunks.length} fragmentos parecidos`);
  }

  // ------------------------------------------------------------------ herramientas vía API de GitHub

  private async readRemoteFile(args: Record<string, unknown>): Promise<AgentToolResult> {
    const rel = cleanRelPath(str(args, 'path'), { allowEmpty: true });
    const repoArg = str(args, 'repo');
    let owner = this.deps.owner;
    let repo = this.deps.repo;
    if (repoArg) {
      const parts = repoArg.split('/');
      if (parts.length > 2 || !parts.every((p) => /^[A-Za-z0-9_.-]+$/.test(p))) return fail('repo inválido (usa "owner/nombre" o "nombre")');
      if (parts.length === 2) [owner, repo] = parts;
      else repo = parts[0];
    }
    const ref = str(args, 'ref');
    if (ref && !/^[A-Za-z0-9_./-]{1,200}$/.test(ref)) return fail('ref inválido');

    const result = await this.deps.git.readRemoteFile({
      installationId: this.deps.installationId,
      owner,
      repo,
      path: rel,
      ref,
      maxChars: MAX_CALL_CHARS,
    });
    const label = `${owner}/${repo}:${rel || '(raíz)'}${ref ? `@${ref}` : ''}`;
    if (!result) return fail(`no se pudo leer ${label} (no existe o la instalación no tiene acceso a ese repo)`);
    if (result.kind === 'dir') return done(cap(`${label}\n${result.entries.slice(0, MAX_LIST_ENTRIES).join('\n')}`), `${result.entries.length} entradas en ${label}`);
    const note = result.truncated ? '\n[archivo recortado]' : '';
    return done(cap(`${label}\n${result.content}${note}`), `leído ${label}`);
  }

  private async pullRequestContext(): Promise<AgentToolResult> {
    const prs = await this.deps.git.getPullRequestContext({
      installationId: this.deps.installationId,
      owner: this.deps.owner,
      repo: this.deps.repo,
      commitSha: this.deps.commitSha,
      pullNumber: this.deps.pullNumber,
    });
    if (prs.length === 0) return done('Este commit no está asociado a ningún Pull Request.', 'sin Pull Request');
    return done(cap(formatPullRequests(prs)), `${prs.length} Pull Request(s)`);
  }
}

export function formatPullRequests(
  prs: { number: number; title: string; body: string; state: string; base: string; head: string; author: string | null; labels: string[]; comments: { author: string | null; body: string }[] }[],
): string {
  return prs
    .map((pr) =>
      [
        `PR #${pr.number} "${pr.title}" (${pr.state}, ${pr.head} → ${pr.base}, por ${pr.author ?? '?'})`,
        pr.labels.length ? `Etiquetas: ${pr.labels.join(', ')}` : '',
        pr.body.trim() ? `Descripción:\n${pr.body.trim()}` : '(sin descripción)',
        ...pr.comments.map((c) => `Comentario de ${c.author ?? '?'}: ${c.body.trim()}`),
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
}

// ----------------------------------------------------------------------------------------------
// Contexto que se arma ANTES de la investigación, sin gastar tokens del modelo.
// ----------------------------------------------------------------------------------------------

/** Últimos commits de cada archivo modificado: por qué están como están. */
export async function buildFileHistorySummary(checkoutPath: string, files: string[], maxFiles = 8, perFile = 3): Promise<string> {
  const lines: string[] = [];
  for (const file of files.filter((f) => !isDeniedPath(f)).slice(0, maxFiles)) {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['--no-pager', 'log', `-n${perFile + 1}`, '--date=short', '--format=%h %ad %an: %s', '--', file],
        { cwd: checkoutPath, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      );
      // El primero es el commit que se está revisando: interesan los anteriores.
      const previous = stdout.trim().split('\n').filter(Boolean).slice(1);
      lines.push(previous.length ? `${file}\n${previous.map((l) => `  ${l}`).join('\n')}` : `${file}\n  (sin commits anteriores: archivo nuevo o de historial corto)`);
    } catch {
      // sin historial disponible para ese archivo: se omite
    }
  }
  return cap(lines.join('\n'), 6_000);
}

const SYMBOL_STOPLIST = new Set([
  'constructor', 'main', 'index', 'init', 'test', 'tests', 'default', 'handler', 'render', 'get', 'set', 'run', 'new', 'make', 'build',
  'create', 'update', 'delete', 'list', 'find', 'data', 'value', 'name', 'type', 'item', 'items', 'result', 'error', 'props', 'state',
]);

/** Símbolos (funciones, clases, métodos…) que las líneas AGREGADAS del diff declaran. */
export function extractDeclaredSymbols(diff: string, max = 10): string[] {
  const found: string[] = [];
  const patterns = [
    /\b(?:function|class|interface|enum|struct|trait|def|fn|func|type)\s+([A-Za-z_$][\w$]{3,})/,
    /\b(?:public|private|protected|static|async|export)\s+(?:async\s+|static\s+)*([A-Za-z_$][\w$]{3,})\s*\(/,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]{3,})\s*=\s*(?:async\s*)?(?:\(|function|[A-Za-z_$][\w$]*\s*=>)/,
  ];
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    for (const re of patterns) {
      const m = line.match(re);
      const symbol = m?.[1];
      if (symbol && !SYMBOL_STOPLIST.has(symbol.toLowerCase()) && !found.includes(symbol)) found.push(symbol);
    }
    if (found.length >= max) break;
  }
  return found.slice(0, max);
}

/** Dónde más se usan los símbolos que el diff declara (excluyendo los propios archivos del diff). */
export async function buildSymbolUsages(checkoutPath: string, diff: string, changedFiles: string[]): Promise<string> {
  const changed = new Set(changedFiles);
  const lines: string[] = [];
  for (const symbol of extractDeclaredSymbols(diff)) {
    try {
      const { stdout } = await execFileAsync('git', ['--no-pager', 'grep', '-l', '-I', '-w', '-F', '-e', symbol, '--'], {
        cwd: checkoutPath,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      }).catch((e: { code?: number; stdout?: string }) => {
        if (e.code === 1) return { stdout: '' };
        throw e;
      });
      const users = stdout.split('\n').filter(Boolean).filter((f) => !changed.has(f) && !isDeniedPath(f));
      lines.push(
        users.length
          ? `${symbol}: usado en ${users.length} archivo(s) fuera de este diff: ${users.slice(0, 6).join(', ')}${users.length > 6 ? ', …' : ''}`
          : `${symbol}: sin usos fuera de los archivos de este diff`,
      );
    } catch {
      // búsqueda fallida para ese símbolo: se omite
    }
  }
  return cap(lines.join('\n'), 5_000);
}
