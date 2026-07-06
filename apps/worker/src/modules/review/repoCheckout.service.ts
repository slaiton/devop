import { Injectable } from '@nestjs/common';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execCb);
const WORKSPACE_ROOT = '/workspace';

export interface CheckoutParams {
  owner: string;
  repo: string;
  commitSha: string;
  installationToken: string;
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
      const url = `https://x-access-token:${params.installationToken}@github.com/${params.owner}/${params.repo}.git`;
      await exec(`git clone "${url}" "${checkoutPath}"`);
      await exec(`git checkout ${params.commitSha}`, { cwd: checkoutPath });
      return await fn(checkoutPath);
    } finally {
      await rm(checkoutPath, { recursive: true, force: true });
    }
  }
}
