import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { redactSecrets } from '../../common/redact';
import { ImageUnavailableError, SandboxRunnerService } from '../review/sandboxRunner.service';
import { parseDiffRanges } from './diffRanges';
import { normalizeFindings } from './normalize';
import { imageFor, SCANNERS, type ScannerDef } from './scanners';
import { describeTechnologies, detectTechnologies } from './techDetect';
import type { Layer1Coverage, Layer1Result, RawFinding, ScannerRun, ScannerStatus } from './types';

const MAX_OUTPUT_BYTES = 40 * 1024 * 1024;
const CONCURRENCY = Math.max(1, Number(process.env.AUDIT_SCANNER_CONCURRENCY) || 2);
/** Directivas con las que un repo puede silenciar a un escáner desde su propio código. Semgrep y Gitleaks se ejecutan
 * ignorándolas; para Checkov y Hadolint no existe un flag, así que se cuentan y se avisan. */
const SUPPRESSION = { checkov: /checkov:skip/i, hadolint: /#\s*hadolint\s+ignore/i };

export interface Layer1Options {
  /** Herramientas que no son obligatorias (si fallan, no vuelven la auditoría incompleta). Por defecto, ninguna. */
  optionalTools?: string[];
}

/** Capa 1 de la auditoría: escáneres deterministas, sin ningún modelo de IA. Decide qué herramientas aplican según lo que
 * hay en el repo, las ejecuta aisladas, normaliza y deduplica lo que reportan, y deja constancia de cuáles NO corrieron:
 * una herramienta que falló o que no pudo ejecutarse nunca cuenta como "sin hallazgos". */
@Injectable()
export class Layer1Service {
  private readonly logger = new Logger(Layer1Service.name);

  constructor(private readonly sandbox: SandboxRunnerService) {}

  async run(checkoutPath: string, diff: string | null, options: Layer1Options = {}): Promise<Layer1Result> {
    const optional = new Set([...(options.optionalTools ?? []), ...(process.env.AUDIT_OPTIONAL_SCANNERS?.split(',').map((s) => s.trim()) ?? [])]);
    const tech = await detectTechnologies(checkoutPath);
    const ranges = diff ? parseDiffRanges(diff) : null;

    // El repo auditado no puede cambiar las reglas de la auditoría: se avisa de sus archivos de configuración y se retiran
    // del checkout (que es una copia temporal). Varias herramientas los cargan solas del directorio escaneado (.semgrepignore,
    // .checkov.yaml…) y no todas tienen una opción para ignorarlos; el resto además se ejecuta con flags que los anulan.
    if (tech.scannerConfigFiles.length > 0) {
      this.logger.warn(`el repo trae archivos que configuran escáneres (se ignoran): ${tech.scannerConfigFiles.join(', ')}`);
      for (const rel of tech.scannerConfigFiles) await rm(join(checkoutPath, rel), { force: true });
    }
    const suppressions = await this.countSuppressions(checkoutPath, tech);

    const target = checkoutPath.split('\\').join('/');
    const runs = new Map<string, ScannerRun>();
    const raw: RawFinding[] = [];

    // Prueba de que los contenedores de los escáneres ven ESTE checkout. Un volumen de trabajo mal configurado haría que
    // todos escanearan un directorio vacío y devolvieran "sin hallazgos": aquí se convierte en un fallo explícito.
    const visibility = await this.checkoutVisible(checkoutPath, target);

    const tasks = SCANNERS.map((def) => async () => {
      const mandatory = def.mandatory && !optional.has(def.tool);
      const applicability = def.applies(tech);
      if (!applicability.applies) {
        runs.set(def.tool, this.record(def, { status: 'skipped', mandatory: false, reason: applicability.reason }));
        return;
      }
      if (visibility) {
        const { image, version } = imageFor(def.tool);
        runs.set(def.tool, this.record(def, { status: 'failed', mandatory, reason: applicability.reason, image, scannerVersion: version, error: visibility }));
        return;
      }
      const { run, findings } = await this.execute(def, mandatory, applicability.reason, target, tech, checkoutPath);
      runs.set(def.tool, run);
      raw.push(...findings);
    });
    await this.pool(tasks, CONCURRENCY);

    const ordered = SCANNERS.map((d) => runs.get(d.tool)!);
    const findings = await normalizeFindings(raw, checkoutPath, ranges);
    for (const run of ordered) run.findingsCount = findings.filter((f) => f.sources.some((s) => s.tool === run.tool)).length;

    const coverage: Layer1Coverage = {
      complete: ordered.every((r) => r.status === 'skipped' || r.status === 'ok' || !r.mandatory),
      missing: ordered.filter((r) => r.mandatory && r.status !== 'ok' && r.status !== 'skipped').map((r) => ({ tool: r.tool, status: r.status, error: r.error })),
      technologies: describeTechnologies(tech),
      suppressions,
      scannerConfigFiles: tech.scannerConfigFiles,
    };
    return { runs: ordered, findings, coverage };
  }

  private async execute(
    def: ScannerDef,
    mandatory: boolean,
    reason: string,
    target: string,
    tech: Parameters<ScannerDef['plan']>[1],
    checkoutPath: string,
  ): Promise<{ run: ScannerRun; findings: RawFinding[] }> {
    const { image, version } = imageFor(def.tool);
    const started = Date.now();
    const base = { mandatory, reason, image, scannerVersion: version };
    try {
      const plan = def.plan(target, tech);
      const result = await this.sandbox.run({
        image,
        cmd: plan.cmd,
        // Se corre desde /tmp (vacío), no desde el repo: así ninguna herramienta carga configuración del repo auditado.
        workdir: '/tmp',
        timeoutMs: def.timeoutMs,
        networkDisabled: !def.network,
        hardened: {
          user: plan.user ?? '65534',
          workspaceReadOnly: true,
          memoryMb: def.memoryMb,
          cpus: 1,
          env: { HOME: '/tmp', ...(plan.env ?? {}) },
          cacheVolume: plan.cacheVolume,
          entrypoint: plan.entrypoint,
          maxOutputBytes: MAX_OUTPUT_BYTES,
        },
      });
      const durationMs = Date.now() - started;
      const imageDigest = await this.sandbox.imageDigest(image);
      const common = { ...base, imageDigest, ruleset: def.ruleset, rulesetPinned: def.rulesetPinned, durationMs, exitCode: result.exitCode };

      if (result.timedOut) {
        return { run: this.record(def, { ...common, status: 'timeout', error: `superó el límite de ${Math.round(def.timeoutMs / 1000)} s` }), findings: [] };
      }
      if (result.truncated) {
        return { run: this.record(def, { ...common, status: 'failed', error: 'la salida superó el límite y se recortó: no es confiable' }), findings: [] };
      }
      if (!def.okExitCodes.includes(result.exitCode)) {
        const detail = redactSecrets((result.stderr || result.stdout).replace(/\s+/g, ' ').trim()).slice(0, 300);
        return { run: this.record(def, { ...common, status: 'failed', error: `terminó con código ${result.exitCode}${detail ? `: ${detail}` : ''}` }), findings: [] };
      }
      try {
        const parsed = def.parse(result.stdout, { checkoutPath });
        return {
          run: this.record(def, { ...common, status: 'ok', scannerVersion: parsed.version ?? version, error: null }),
          findings: parsed.findings,
        };
      } catch (err) {
        return { run: this.record(def, { ...common, status: 'failed', error: (err as Error).message.slice(0, 300) }), findings: [] };
      }
    } catch (err) {
      const status: ScannerStatus = err instanceof ImageUnavailableError ? 'not_installed' : 'failed';
      this.logger.warn(`${def.label}: ${(err as Error).message}`);
      return {
        run: this.record(def, { ...base, status, durationMs: Date.now() - started, error: redactSecrets((err as Error).message).slice(0, 300) }),
        findings: [],
      };
    }
  }

  /** null si el contenedor del sandbox ve el checkout; si no, el motivo. */
  private async checkoutVisible(checkoutPath: string, target: string): Promise<string | null> {
    const canary = `.devsentinel-canary-${randomBytes(6).toString('hex')}`;
    const { image } = imageFor('gitleaks');
    try {
      await writeFile(join(checkoutPath, canary), 'canary');
      const res = await this.sandbox.run({
        image,
        cmd: [`${target}/${canary}`],
        workdir: '/tmp',
        timeoutMs: 60_000,
        networkDisabled: true,
        hardened: { user: '65534', workspaceReadOnly: true, memoryMb: 64, entrypoint: ['test', '-f'], maxOutputBytes: 10_000 },
      });
      return res.exitCode === 0
        ? null
        : 'el contenedor del escáner no ve el repositorio clonado (¿el volumen de trabajo del sandbox no es el del worker? revisa WORKSPACE_VOLUME y el nombre del volumen en docker-compose)';
    } catch (err) {
      return `no se pudo comprobar que el escáner ve el repositorio: ${(err as Error).message.slice(0, 200)}`;
    } finally {
      await rm(join(checkoutPath, canary), { force: true });
    }
  }

  private record(def: ScannerDef, partial: Partial<ScannerRun> & { status: ScannerStatus }): ScannerRun {
    return {
      tool: def.tool,
      mandatory: def.mandatory,
      reason: null,
      scannerVersion: null,
      image: null,
      imageDigest: null,
      ruleset: null,
      rulesetPinned: false,
      durationMs: null,
      exitCode: null,
      error: null,
      findingsCount: 0,
      ...partial,
    };
  }

  /** Cuántas directivas de supresión trae el repo para las herramientas que no se pueden ejecutar ignorándolas. */
  private async countSuppressions(checkoutPath: string, tech: Parameters<ScannerDef['plan']>[1]): Promise<Record<string, number>> {
    const count = async (files: string[], pattern: RegExp) => {
      let n = 0;
      for (const rel of files.slice(0, 400)) {
        try {
          const text = await readFile(join(checkoutPath, rel), 'utf8');
          n += text.split('\n').filter((l) => pattern.test(l)).length;
        } catch {
          // archivo ilegible: no cuenta
        }
      }
      return n;
    };
    const out: Record<string, number> = {};
    const hadolint = await count(tech.dockerfiles, SUPPRESSION.hadolint);
    if (hadolint) out.hadolint = hadolint;
    const checkov = await count([...tech.terraformFiles, ...tech.iacFiles], SUPPRESSION.checkov);
    if (checkov) out.checkov = checkov;
    return out;
  }

  private async pool(tasks: (() => Promise<void>)[], limit: number): Promise<void> {
    const queue = [...tasks];
    const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let task = queue.shift(); task; task = queue.shift()) await task();
    });
    await Promise.all(workers);
  }
}
