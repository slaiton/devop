import { Injectable, Logger } from '@nestjs/common';
import { getPool, withTenant } from '@devsentinel/database';
import { buildGithubAdapterForInstallation } from '@devsentinel/github-apps';
import { OpenAiCompatibleLlmAdapter, embedLocally, type ProjectProfileExtraction } from '@devsentinel/llm-port';
import { getSystemSettings } from '@devsentinel/settings';
import type { ProjectContextJobPayload } from '@devsentinel/event-contracts';

const SCALAR_FIELDS = [
  'language',
  'framework',
  'framework_version',
  'runtime',
  'database',
  'architecture_style',
  'testing_strategy',
  'notes',
  'migrations_policy',
  'compatibility_notes',
] as const;
const LIST_FIELDS = ['mandatory_rules', 'security_rules', 'conventions'] as const;

type ProfileRow = Record<(typeof SCALAR_FIELDS)[number], string | null> &
  Record<(typeof LIST_FIELDS)[number], string[]> & { auto_generated_from: string[] | null };

const clean = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};
const cleanList = (values: string[] | null | undefined): string[] =>
  (values ?? []).map((v) => v.trim()).filter(Boolean).slice(0, 25);

/** Mensaje para la UI: el error técnico crudo de Octokit/axios no le sirve a quien pulsó el botón. */
function describeError(err: unknown): string {
  const status = (err as { status?: number }).status;
  if (status === 401 || status === 403) {
    return 'GitHub rechazó la lectura del repositorio (permiso Contents: Read sin aceptar en la instalación, o la instalación está suspendida).';
  }
  if (status === 404) return 'GitHub no encontró el repositorio: revisa que la App siga instalada en él.';
  return (err as Error).message || 'error desconocido';
}

@Injectable()
export class ProjectContextService {
  private readonly logger = new Logger(ProjectContextService.name);

  /** Lee README / CLAUDE.md / manifiestos del repo (rama por defecto) y arma su perfil con el LLM.
   * Nunca lanza: cualquier fallo queda en la fila `project_context_runs` para que la UI lo muestre
   * (un reintento automático de BullMQ no aportaría: el usuario vuelve a pulsar el botón). */
  async process(payload: ProjectContextJobPayload): Promise<void> {
    const { organizationId, repositoryId, runId } = payload;
    try {
      await withTenant(organizationId, (client) =>
        client.query(`UPDATE project_context_runs SET status = 'running' WHERE id = $1`, [runId]),
      );

      const repo = await withTenant(organizationId, async (client) => {
        const { rows } = await client.query(
          `SELECT r.full_name, gi.installation_id
           FROM repositories r
           JOIN github_installations gi ON gi.id = r.github_installation_id
           WHERE r.id = $1`,
          [repositoryId],
        );
        return rows[0] as { full_name: string; installation_id: string | number } | undefined;
      });
      if (!repo) throw new Error('el repositorio ya no existe o no tiene una instalación de GitHub asociada');
      const installationId = Number(repo.installation_id);
      const [owner, name] = repo.full_name.split('/');

      const settings = await getSystemSettings(getPool());
      if (!settings?.llmModel || !settings.llmProviderBaseUrl) {
        throw new Error('el proveedor de LLM no está configurado: complétalo en Configuración y vuelve a intentar');
      }
      const llm = new OpenAiCompatibleLlmAdapter(
        settings.llmModel,
        settings.llmProviderBaseUrl,
        settings.llmProviderApiKey ?? '',
        embedLocally,
      );

      const gitAdapter = await withTenant(organizationId, (client) =>
        buildGithubAdapterForInstallation(client, installationId),
      );
      const documents = await gitAdapter.collectProjectContext({ installationId, owner, repo: name });
      const readable = documents.filter((d) => !d.path.startsWith('('));
      if (readable.length === 0) {
        throw new Error(
          'el repositorio no tiene README, CLAUDE.md / AGENTS.md ni archivos de dependencias en la raíz de la rama por defecto: no hay de dónde sacar contexto',
        );
      }

      const extracted = await llm.extractProjectProfile({ repositoryFullName: repo.full_name, documents });
      const sources = readable.map((d) => d.path);
      const applied = await this.applyProfile(payload, extracted, sources);

      await withTenant(organizationId, (client) =>
        client.query(
          `UPDATE project_context_runs
           SET status = 'done', sources = $2, applied_fields = $3, error_message = NULL, finished_at = now()
           WHERE id = $1`,
          [runId, sources, applied],
        ),
      );
      this.logger.log(`contexto de ${repo.full_name} generado desde ${sources.join(', ')} (${applied.length} campos)`);
    } catch (err) {
      this.logger.warn(`no se pudo generar el contexto del repo ${repositoryId}: ${(err as Error).message}`);
      await withTenant(organizationId, (client) =>
        client.query(
          `UPDATE project_context_runs SET status = 'failed', error_message = $2, finished_at = now() WHERE id = $1`,
          [runId, describeError(err).slice(0, 500)],
        ),
      ).catch((e) => this.logger.error(`no se pudo registrar el fallo de la corrida ${runId}: ${(e as Error).message}`));
    }
  }

  /** Perfil nuevo o generado antes por la IA → se reemplaza por lo detectado. Perfil que una
   * persona configuró → solo se completan los campos vacíos (salvo `mode: 'replace'`, que el admin
   * pide explícitamente), así regenerar nunca borra trabajo manual. Devuelve los campos escritos. */
  private async applyProfile(
    payload: ProjectContextJobPayload,
    extracted: ProjectProfileExtraction,
    sources: string[],
  ): Promise<string[]> {
    return withTenant(payload.organizationId, async (client) => {
      const { rows } = await client.query(
        `SELECT language, framework, framework_version, runtime, database, architecture_style, testing_strategy,
                notes, migrations_policy, compatibility_notes, mandatory_rules, security_rules, conventions,
                auto_generated_from
         FROM project_profiles WHERE repository_id = $1 FOR UPDATE`,
        [payload.repositoryId],
      );
      const existing = rows[0] as ProfileRow | undefined;
      const curated = Boolean(existing) && existing!.auto_generated_from === null;
      const fillOnly = curated && payload.mode === 'fill';

      const next: Record<string, string | string[] | null> = {};
      const applied: string[] = [];
      for (const field of SCALAR_FIELDS) {
        const detected = clean(extracted[field]);
        const current = existing?.[field] ?? null;
        const value = fillOnly ? (clean(current) ?? detected) : detected;
        next[field] = value;
        if (value && value !== current) applied.push(field);
      }
      for (const field of LIST_FIELDS) {
        const detected = cleanList(extracted[field]);
        const current = existing?.[field] ?? [];
        const value = fillOnly ? (current.length > 0 ? current : detected) : detected;
        next[field] = value;
        if (value.length > 0 && JSON.stringify(value) !== JSON.stringify(current)) applied.push(field);
      }

      // Un perfil curado que solo se completó sigue siendo "de una persona" (NULL); si se
      // reemplazó o es nuevo, queda marcado como borrador generado, con sus fuentes.
      const autoGeneratedFrom = fillOnly ? null : sources;

      await client.query(
        `INSERT INTO project_profiles
           (organization_id, repository_id, language, framework, framework_version, runtime, database,
            architecture_style, testing_strategy, notes, mandatory_rules, security_rules, conventions,
            migrations_policy, compatibility_notes, auto_generated_from)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (repository_id) DO UPDATE SET
           language = $3, framework = $4, framework_version = $5, runtime = $6, database = $7,
           architecture_style = $8, testing_strategy = $9, notes = $10, mandatory_rules = $11,
           security_rules = $12, conventions = $13, migrations_policy = $14, compatibility_notes = $15,
           auto_generated_from = $16, updated_at = now()`,
        [
          payload.organizationId,
          payload.repositoryId,
          next.language,
          next.framework,
          next.framework_version,
          next.runtime,
          next.database,
          next.architecture_style,
          next.testing_strategy,
          next.notes,
          next.mandatory_rules,
          next.security_rules,
          next.conventions,
          next.migrations_policy,
          next.compatibility_notes,
          autoGeneratedFrom,
        ],
      );
      return applied;
    });
  }
}
