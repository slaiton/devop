import type { PoolClient } from 'pg';

export type GateDecision = 'apto' | 'requiere_revision' | 'no_apto';

export interface GateConfig {
  block_on_risk_level: 'medium' | 'high';
  block_on_secret: boolean;
}

export const DEFAULT_GATE: GateConfig = { block_on_risk_level: 'high', block_on_secret: true };

// Categorías donde un finding critical fuerza NO APTO sin importar el score o lo que
// sugiera el LLM — regla dura determinista, no a discreción del modelo.
export const HARD_BLOCK_CATEGORIES = new Set(['security', 'architecture', 'database', 'regression']);

export async function loadGateConfig(client: PoolClient, organizationId: string, repositoryId: string): Promise<GateConfig> {
  const { rows } = await client.query(
    `SELECT block_on_risk_level, block_on_secret
     FROM quality_gate_configs
     WHERE organization_id = $1 AND (repository_id = $2 OR repository_id IS NULL)
     ORDER BY repository_id NULLS LAST
     LIMIT 1`,
    [organizationId, repositoryId],
  );
  return rows[0] ?? DEFAULT_GATE;
}

/** Recalcula el veredicto de un commit a partir de sus hallazgos VIGENTES (después de una reconsideración o de que la IA
 * resolviera una pregunta). Los hallazgos en `open` bloquean según su severidad y categoría; los que siguen como pregunta
 * (`awaiting_clarification`) NO bloquean, pero impiden aprobar el commit: mientras haya preguntas sin resolver el
 * resultado es, como mucho, REQUIERE_REVISIÓN. Un riesgo alto que solo se debe a preguntas tampoco se vuelve NO APTO. */
export async function recomputeGateDecision(
  client: PoolClient,
  reviewRunId: string,
  riskLevel: 'low' | 'medium' | 'high',
  qualityScore: number,
  config: GateConfig,
): Promise<GateDecision> {
  const { rows } = await client.query(
    `SELECT category, severity, title, status FROM findings
     WHERE review_run_id = $1 AND status IN ('open', 'awaiting_clarification')`,
    [reviewRunId],
  );
  const open = rows.filter((f: { status: string }) => f.status === 'open');
  const awaiting = rows.filter((f: { status: string }) => f.status === 'awaiting_clarification');

  if (open.some((f: { severity: string; category: string }) => f.severity === 'critical' && HARD_BLOCK_CATEGORIES.has(f.category))) {
    return 'no_apto';
  }
  if (config.block_on_secret && open.some((f: { category: string; title: string }) => f.category === 'security' && /secret|credential|token/i.test(f.title))) {
    return 'no_apto';
  }

  const confirmedSerious = open.some((f: { severity: string }) => f.severity === 'high' || f.severity === 'critical');
  const blockingRiskLevels = config.block_on_risk_level === 'medium' ? ['medium', 'high'] : ['high'];
  if (blockingRiskLevels.includes(riskLevel)) return awaiting.length > 0 && !confirmedSerious ? 'requiere_revision' : 'no_apto';

  if (awaiting.length > 0) return 'requiere_revision';
  if (riskLevel === 'high') return 'requiere_revision';
  if (riskLevel === 'medium' && qualityScore < 70) return 'requiere_revision';
  return 'apto';
}

export function checkConclusion(decision: GateDecision): 'success' | 'neutral' | 'failure' {
  return decision === 'apto' ? 'success' : decision === 'requiere_revision' ? 'neutral' : 'failure';
}
