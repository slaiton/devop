import { Injectable } from '@nestjs/common';
import Docker from 'dockerode';
import { PassThrough } from 'stream';

const WORKSPACE_VOLUME = process.env.WORKSPACE_VOLUME?.trim() || 'devsentinel_workspace';

/** Endurecimiento extra para los escáneres de la auditoría por capas. Sin esto el contenedor se comporta como siempre. */
export interface HardenedOptions {
  /** Usuario sin privilegios (por defecto el de la imagen). */
  user?: string;
  /** /workspace en solo lectura (el escáner no necesita escribir en el checkout). */
  workspaceReadOnly?: boolean;
  memoryMb?: number;
  cpus?: number;
  env?: Record<string, string>;
  /** Volumen de caché (p. ej. la base de vulnerabilidades de Trivy) que persiste entre ejecuciones. */
  cacheVolume?: { name: string; target: string };
  /** Tope de bytes de stdout/stderr que se conservan (el resto se descarta). */
  maxOutputBytes?: number;
  /** Reemplaza el ENTRYPOINT de la imagen. */
  entrypoint?: string[];
}

export interface RunContainerParams {
  image: string;
  cmd: string[];
  workdir: string;
  timeoutMs: number;
  networkDisabled?: boolean;
  hardened?: HardenedOptions;
}

export interface RunContainerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** El contenedor se mató por superar el tiempo límite. */
  timedOut: boolean;
  /** La salida superó el tope y se recortó. */
  truncated: boolean;
}

/** No se pudo obtener la imagen del escáner: no está instalado/disponible, que es distinto de "falló al ejecutarse". */
export class ImageUnavailableError extends Error {
  constructor(image: string, cause: string) {
    super(`no se pudo obtener la imagen ${image}: ${cause}`);
    this.name = 'ImageUnavailableError';
  }
}

/**
 * Lanza contenedores Docker "sibling" (sobre el socket del host) endurecidos:
 * sin red por defecto, límites de CPU/memoria y timeout forzado. Con `hardened` además: filesystem raíz de solo lectura,
 * sin capabilities, sin escalada de privilegios, usuario no-root y /workspace de solo lectura. Ver
 * docs/architecture/08-mvp-fase0-stack.md sección 6 para el trade-off de seguridad aceptado en esta fase.
 */
@Injectable()
export class SandboxRunnerService {
  private readonly docker = new Docker();

  async run(params: RunContainerParams): Promise<RunContainerResult> {
    await this.ensureImage(params.image);
    const hardened = params.hardened;

    const binds = [`${WORKSPACE_VOLUME}:/workspace${hardened?.workspaceReadOnly ? ':ro' : ''}`];
    if (hardened?.cacheVolume) binds.push(`${hardened.cacheVolume.name}:${hardened.cacheVolume.target}`);

    const memory = (hardened?.memoryMb ?? 512) * 1024 * 1024;
    const container = await this.docker.createContainer({
      Image: params.image,
      Cmd: params.cmd,
      ...(hardened?.entrypoint ? { Entrypoint: hardened.entrypoint } : {}),
      ...(hardened?.user ? { User: hardened.user } : {}),
      ...(hardened?.env ? { Env: Object.entries(hardened.env).map(([k, v]) => `${k}=${v}`) } : {}),
      WorkingDir: params.workdir,
      Tty: false,
      HostConfig: {
        Binds: binds,
        NetworkMode: params.networkDisabled === false ? 'bridge' : 'none',
        Memory: memory,
        ...(hardened ? { MemorySwap: memory, NanoCpus: Math.round((hardened.cpus ?? 1) * 1e9) } : {}),
        PidsLimit: 256,
        AutoRemove: true,
        ...(hardened
          ? {
              ReadonlyRootfs: true,
              CapDrop: ['ALL'],
              SecurityOpt: ['no-new-privileges'],
              // El escáner escribe aquí lo que necesite (HOME, cachés temporales); desaparece con el contenedor.
              Tmpfs: { '/tmp': 'rw,exec,nosuid,size=512m' },
            }
          : {}),
      },
    });

    const maxBytes = hardened?.maxOutputBytes ?? Number.POSITIVE_INFINITY;
    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    let stdout = '';
    let stderr = '';
    let truncated = false;
    const collect = (append: (s: string) => void, current: () => number) => (chunk: Buffer) => {
      if (current() >= maxBytes) {
        truncated = true;
        return;
      }
      append(chunk.toString('utf-8'));
    };
    stdoutStream.on('data', collect((s) => (stdout += s), () => stdout.length));
    stderrStream.on('data', collect((s) => (stderr += s), () => stderr.length));

    const attachStream = await container.attach({ stream: true, stdout: true, stderr: true });
    container.modem.demuxStream(attachStream, stdoutStream, stderrStream);

    await container.start();

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      container.kill().catch(() => undefined);
    }, params.timeoutMs);

    try {
      const { StatusCode } = await container.wait();
      return { exitCode: StatusCode, stdout, stderr, timedOut, truncated };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Resumen (digest) de la imagen local, para dejar constancia de qué versión exacta se ejecutó. */
  async imageDigest(image: string): Promise<string | null> {
    try {
      const info = await this.docker.getImage(image).inspect();
      const pinned = image.includes('@sha256:') ? image.split('@')[1] : null;
      return pinned ?? info.RepoDigests?.[0]?.split('@')[1] ?? info.Id ?? null;
    } catch {
      return null;
    }
  }

  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
    } catch {
      try {
        await new Promise<void>((resolve, reject) => {
          this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
            if (err) return reject(err);
            this.docker.modem.followProgress(stream, (err2: Error | null) => (err2 ? reject(err2) : resolve()));
          });
        });
      } catch (err) {
        throw new ImageUnavailableError(image, (err as Error).message);
      }
    }
  }
}
