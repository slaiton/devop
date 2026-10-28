import { getPool } from '@devsentinel/database';
import { LlmNotConfiguredError, buildLlmRouter, type LlmRouter } from '@devsentinel/llm-port';
import { getLlmRoutingMode, listLlmProviders, nextLlmTurn, recordLlmProviderResult } from '@devsentinel/settings';

/** Arma el enrutador de agentes de IA con la configuración vigente (Configuración → Agentes de IA).
 * Se hace por tarea, no al arrancar, para que cambiar el orden, el modo o las claves aplique al
 * siguiente análisis sin reiniciar el worker. En modo "intercalar" toma el siguiente turno de una
 * rotación compartida en la base: cada análisis empieza por un agente distinto. */
export async function createLlmRouter(): Promise<LlmRouter> {
  const pool = getPool();
  const providers = await listLlmProviders(pool, { onlyEnabled: true });
  if (providers.length === 0) throw new LlmNotConfiguredError();

  const mode = await getLlmRoutingMode(pool);
  const turn = mode === 'round_robin' && providers.length > 1 ? await nextLlmTurn(pool) : 0;

  return buildLlmRouter(providers, {
    mode,
    turn,
    onAttempt: async (record) => {
      // Que un agente no soporte herramientas no es una falla del agente: no se anota como error.
      if (record.unsupported) return;
      await recordLlmProviderResult(pool, record.providerId, record.ok, record.error);
    },
  });
}
