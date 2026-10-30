import { getPool } from '@devsentinel/database';
import { LlmNotConfiguredError, buildLlmRouter, type LlmRouter } from '@devsentinel/llm-port';
import { getLlmRoutingMode, listLlmProviders, nextLlmTurn, recordLlmProviderResult, type LlmAuditLayer } from '@devsentinel/settings';
import { UsageSink } from './usageSink';

export { UsageSink };

/** A qué se atribuye el consumo de las llamadas al modelo (costos y presupuesto). Sin `organizationId` no se registra (la tabla es
 * por organización). Con `sink` se acumula en el de la revisión; sin él, se registra por su cuenta. */
export interface UsageContext {
  organizationId?: string;
  reviewRunId?: string | null;
  repositoryId?: string | null;
  /** review, layer2, layer3, reconsider, clarification, issue_reply, project_profile… */
  purpose: string;
  sink?: UsageSink;
}

function usageHandler(ctx?: UsageContext) {
  if (!ctx) return undefined;
  if (ctx.sink) return ctx.sink.handler(ctx.purpose);
  if (!ctx.organizationId) return undefined;
  return new UsageSink({ organizationId: ctx.organizationId, reviewRunId: ctx.reviewRunId, repositoryId: ctx.repositoryId }).handler(ctx.purpose);
}

const onAttempt = (pool: ReturnType<typeof getPool>) => async (record: { unsupported?: boolean; providerId: string; ok: boolean; error?: string }) => {
  // Que un agente no soporte herramientas no es una falla del agente: no se anota como error.
  if (record.unsupported) return;
  await recordLlmProviderResult(pool, record.providerId, record.ok, record.error);
};

/** Arma el enrutador de agentes de IA con la configuración vigente (Configuración → Agentes de IA).
 * Se hace por tarea, no al arrancar, para que cambiar el orden, el modo o las claves aplique al
 * siguiente análisis sin reiniciar el worker. En modo "intercalar" toma el siguiente turno de una
 * rotación compartida en la base: cada análisis empieza por un agente distinto.
 *
 * Usa los agentes GENERALES (los que no están asignados a una capa de la auditoría). Si no hay ninguno, usa todos los activos
 * para que reconsideraciones, aclaraciones y demás tareas sigan funcionando. */
export async function createLlmRouter(ctx?: UsageContext): Promise<LlmRouter> {
  const pool = getPool();
  let providers = await listLlmProviders(pool, { onlyEnabled: true, layer: 'general' });
  if (providers.length === 0) providers = await listLlmProviders(pool, { onlyEnabled: true });
  if (providers.length === 0) throw new LlmNotConfiguredError();

  const mode = await getLlmRoutingMode(pool);
  const turn = mode === 'round_robin' && providers.length > 1 ? await nextLlmTurn(pool) : 0;

  return buildLlmRouter(providers, { mode, turn, onAttempt: onAttempt(pool), onUsage: usageHandler(ctx) });
}

/** Enrutador de los agentes asignados a una capa de la auditoría (en el orden configurado, con respaldo entre ellos), o null si
 * ninguno está asignado/activo. NO cae a los agentes generales: gastar un modelo caro en el triaje sería violar el diseño. */
export async function createLayerRouter(
  layer: LlmAuditLayer,
  ctx?: UsageContext,
  options: { reasoningEffort?: string; maxOutputTokens?: number } = {},
): Promise<{ router: LlmRouter; models: string[] } | null> {
  const pool = getPool();
  const providers = await listLlmProviders(pool, { onlyEnabled: true, layer });
  if (providers.length === 0) return null;
  const router = buildLlmRouter(providers, {
    mode: 'failover',
    onAttempt: onAttempt(pool),
    onUsage: usageHandler(ctx),
    triage: { reasoningEffort: options.reasoningEffort, maxOutputTokens: options.maxOutputTokens },
  });
  return { router, models: providers.map((p) => p.model) };
}
