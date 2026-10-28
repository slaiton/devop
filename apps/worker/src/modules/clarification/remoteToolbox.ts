import type { GitProviderPort } from '@devsentinel/git-providers';
import type { AgentToolbox, AgentToolDefinition, AgentToolResult } from '@devsentinel/llm-port';
import { cap, cleanRelPath, done, fail, formatPullRequests, str } from '../review/reviewToolbox';

const MAX_CALL_CHARS = 20_000;

const DEFS: AgentToolDefinition[] = [
  {
    name: 'read_remote_file',
    description:
      'Lee un archivo (o lista una carpeta) de un repositorio de la misma instalación vía la API de GitHub. Sin "repo" es el repositorio analizado. Con "ref" eliges rama, tag o commit; sin ref es la rama por defecto.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta del archivo o carpeta (vacío = raíz).' },
        repo: { type: 'string', description: 'Opcional: "owner/nombre" o solo "nombre" (mismo owner). Debe estar en la lista de repositorios legibles.' },
        ref: { type: 'string', description: 'Opcional: rama, tag o SHA.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_remote_code',
    description:
      'Busca texto en el código de un repositorio legible (solo su rama por defecto; límite bajo de búsquedas por minuto). Devuelve rutas: luego léelas con read_remote_file.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texto a buscar (un identificador, nombre de función, ruta de endpoint…).' },
        repo: { type: 'string', description: 'Opcional: "owner/nombre" o "nombre". Por defecto el repositorio analizado.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_pull_request_context',
    description: 'Título, descripción y primeros comentarios del Pull Request relacionado con el commit analizado.',
    parameters: { type: 'object', properties: {} },
  },
];

export interface RemoteToolboxDeps {
  git: GitProviderPort;
  installationId: number;
  owner: string;
  repo: string;
  commitSha: string;
  pullNumber?: number;
  /** Repositorios que la IA puede leer ("owner/nombre"): los de la misma instalación registrados en la organización. */
  readable: string[];
}

/** Herramientas de solo lectura sobre GitHub para verificar una pregunta (otro repo, otra rama, el PR). Solo se pueden leer
 * los repositorios de la lista `readable`: la instalación puede tener acceso a más, pero la IA solo mira los que ya
 * están dados de alta en la plataforma. */
export class RemoteToolbox implements AgentToolbox {
  readonly definitions = DEFS;
  private readonly allowed: Set<string>;

  constructor(private readonly deps: RemoteToolboxDeps) {
    this.allowed = new Set(deps.readable.map((r) => r.toLowerCase()));
    this.allowed.add(`${deps.owner}/${deps.repo}`.toLowerCase());
  }

  async execute(name: string, args: Record<string, unknown>): Promise<AgentToolResult> {
    try {
      switch (name) {
        case 'read_remote_file':
          return await this.readRemoteFile(args);
        case 'search_remote_code':
          return await this.searchRemoteCode(args);
        case 'get_pull_request_context':
          return await this.pullRequestContext();
        default:
          return fail(`herramienta desconocida "${name}"`);
      }
    } catch (err) {
      return fail(((err as Error).message ?? 'error').slice(0, 300));
    }
  }

  private resolveRepo(raw: string | undefined): { owner: string; repo: string } | { error: string } {
    if (!raw) return { owner: this.deps.owner, repo: this.deps.repo };
    const parts = raw.trim().split('/');
    if (parts.length > 2 || !parts.every((p) => /^[A-Za-z0-9_.-]+$/.test(p))) return { error: 'repo inválido (usa "owner/nombre" o "nombre")' };
    const [owner, repo] = parts.length === 2 ? parts : [this.deps.owner, parts[0]];
    if (!this.allowed.has(`${owner}/${repo}`.toLowerCase())) {
      return { error: `no puedo leer ${owner}/${repo}: solo ${[...this.allowed].join(', ')}` };
    }
    return { owner, repo };
  }

  private async readRemoteFile(args: Record<string, unknown>): Promise<AgentToolResult> {
    const target = this.resolveRepo(str(args, 'repo'));
    if ('error' in target) return fail(target.error);
    const rel = cleanRelPath(str(args, 'path'), { allowEmpty: true });
    const ref = str(args, 'ref');
    if (ref && !/^[A-Za-z0-9_./-]{1,200}$/.test(ref)) return fail('ref inválido');

    const result = await this.deps.git.readRemoteFile({
      installationId: this.deps.installationId,
      owner: target.owner,
      repo: target.repo,
      path: rel,
      ref,
      maxChars: MAX_CALL_CHARS,
    });
    const label = `${target.owner}/${target.repo}:${rel || '(raíz)'}${ref ? `@${ref}` : ''}`;
    if (!result) return fail(`no se pudo leer ${label} (no existe o la instalación no tiene acceso)`);
    if (result.kind === 'dir') return done(cap(`${label}\n${result.entries.slice(0, 200).join('\n')}`), `${result.entries.length} entradas en ${label}`);
    return done(cap(`${label}\n${result.content}${result.truncated ? '\n[archivo recortado]' : ''}`), `leído ${label}`);
  }

  private async searchRemoteCode(args: Record<string, unknown>): Promise<AgentToolResult> {
    const target = this.resolveRepo(str(args, 'repo'));
    if ('error' in target) return fail(target.error);
    const query = str(args, 'query');
    if (!query || query.length > 120 || query.includes('\0')) return fail('consulta inválida o demasiado larga');
    // Los calificadores de GitHub (repo:, org:, user:, path:…) cambiarían dónde se busca: no se aceptan.
    if (/\b(repo|org|user|owner|path|filename|extension|in|language|size|fork):/i.test(query)) return fail('la consulta no puede llevar calificadores (repo:, org:, user:…)');
    const matches = await this.deps.git.searchRemoteCode({ installationId: this.deps.installationId, owner: target.owner, repo: target.repo, query });
    if (matches.length === 0) return done('Sin coincidencias en la rama por defecto.', 'sin coincidencias');
    return done(cap(`${matches.length} archivos en ${target.owner}/${target.repo}\n${matches.map((m) => m.path).join('\n')}`), `${matches.length} archivos con "${query}"`);
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
