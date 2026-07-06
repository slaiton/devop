import { Injectable } from '@nestjs/common';
import Docker from 'dockerode';
import { PassThrough } from 'stream';

const WORKSPACE_VOLUME = 'devsentinel_workspace';

export interface RunContainerParams {
  image: string;
  cmd: string[];
  workdir: string;
  timeoutMs: number;
  networkDisabled?: boolean;
}

export interface RunContainerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Lanza contenedores Docker "sibling" (sobre el socket del host) endurecidos:
 * sin red por defecto, filesystem de solo lectura salvo /workspace, límites de
 * CPU/memoria y timeout forzado. Ver docs/architecture/08-mvp-fase0-stack.md
 * sección 6 para el trade-off de seguridad aceptado en esta fase.
 */
@Injectable()
export class SandboxRunnerService {
  private readonly docker = new Docker();

  async run(params: RunContainerParams): Promise<RunContainerResult> {
    await this.ensureImage(params.image);

    const container = await this.docker.createContainer({
      Image: params.image,
      Cmd: params.cmd,
      WorkingDir: params.workdir,
      Tty: false,
      HostConfig: {
        Binds: [`${WORKSPACE_VOLUME}:/workspace`],
        NetworkMode: params.networkDisabled === false ? 'bridge' : 'none',
        Memory: 512 * 1024 * 1024,
        PidsLimit: 256,
        AutoRemove: true,
      },
    });

    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    let stdout = '';
    let stderr = '';
    stdoutStream.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf-8')));
    stderrStream.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf-8')));

    const attachStream = await container.attach({ stream: true, stdout: true, stderr: true });
    container.modem.demuxStream(attachStream, stdoutStream, stderrStream);

    await container.start();

    const timeout = setTimeout(() => {
      container.kill().catch(() => undefined);
    }, params.timeoutMs);

    try {
      const { StatusCode } = await container.wait();
      return { exitCode: StatusCode, stdout, stderr };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
    } catch {
      await new Promise<void>((resolve, reject) => {
        this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
          if (err) return reject(err);
          this.docker.modem.followProgress(stream, (err2: Error | null) => (err2 ? reject(err2) : resolve()));
        });
      });
    }
  }
}
