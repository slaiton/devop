import { Injectable } from '@nestjs/common';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

const execFile = promisify(execFileCb);
const WORKSPACE_ROOT = '/workspace';

export interface CheckoutParams {
  owner: string;
  repo: string;
  commitSha: string;
  installationToken: string;
}

/** `GITHUB_GIT_URL` apunta los clones a otro servidor git (GitHub Enterprise Server, o un servidor
 * local en pruebas). Sin definir, github.com. */
function gitBaseUrl(): string {
  return (process.env.GITHUB_GIT_URL?.trim() || 'https://github.com').replace(/\/+$/, '');
}

/**
 * Clona el repo en el volumen Docker compartido `devsentinel_workspace`, visible
 * tanto por el worker como por los contenedores sibling que lanza SandboxRunnerService
 * (mismo punto de montaje /workspace en ambos, por eso funciona sin alinear paths del host).
 */
@Injectable()
export class RepoCheckoutService {
  async withCheckout<T>(params: CheckoutParams, fn: (checkoutPath: string) => Promise<T>): Promise<T> {
    const checkoutPath = await mkdtemp(join(WORKSPACE_ROOT, 'job-'));
    try {
      const base = gitBaseUrl();
      const plainUrl = `${base}/${params.owner}/${params.repo}.git`;
      const authUrl = base.startsWith('http')
        ? plainUrl.replace('://', `://x-access-token:${params.installationToken}@`)
        : plainUrl;
      await execFile('git', ['clone', authUrl, checkoutPath]);
      // El clon deja el token en la URL del remoto (.git/config). Se quita ya mismo: ese directorio
      // lo ven los analizadores estáticos (contenedores hermanos) y, en el análisis profundo, el
      // revisor con sus herramientas de lectura.
      await execFile('git', ['remote', 'set-url', 'origin', plainUrl], { cwd: checkoutPath });
      await execFile('git', ['checkout', params.commitSha], { cwd: checkoutPath });
      return await fn(checkoutPath);
    } finally {
      await rm(checkoutPath, { recursive: true, force: true });
    }
  }
}
