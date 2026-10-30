import type { PoolClient } from 'pg';
import type { AuditGuards } from './policy';
import type { Layer1Result } from './types';
import type { Layer2Outcome } from './layer2/layer2.service';

export type AuditStage = 'pending' | 'running_layer_1' | 'running_layer_2' | 'running_layer_3' | 'completed' | 'failed' | 'cancelled';

export async function setAuditStage(client: PoolClient, reviewRunId: string, stage: AuditStage): Promise<void> {
  await client.query('UPDATE review_runs SET audit_stage = $1 WHERE id = $2', [stage, reviewRunId]);
}

/** Guarda la capa 1 de una revisión. Idempotente ante reintentos del trabajo (reemplaza lo anterior de ESA revisión). */
export async function saveLayer1(
  client: PoolClient,
  organizationId: string,
  reviewRunId: string,
  layer1: Layer1Result,
  guards: AuditGuards,
  policyReasons: string[],
): Promise<void> {
  await client.query('DELETE FROM scanner_runs WHERE review_run_id = $1', [reviewRunId]);
  await client.query('DELETE FROM scan_findings WHERE review_run_id = $1', [reviewRunId]);

  for (const run of layer1.runs) {
    await client.query(
      `INSERT INTO scanner_runs
         (organization_id, review_run_id, tool, status, mandatory, reason, scanner_version, image, image_digest, ruleset, ruleset_pinned,
          duration_ms, exit_code, error, findings_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        organizationId, reviewRunId, run.tool, run.status, run.mandatory, run.reason, run.scannerVersion, run.image, run.imageDigest,
        run.ruleset, run.rulesetPinned, run.durationMs, run.exitCode, run.error, run.findingsCount,
      ],
    );
  }

  for (const f of layer1.findings) {
    await client.query(
      `INSERT INTO scan_findings
         (organization_id, review_run_id, tool, sources, rule_id, severity, category, file_path, line_start, line_end, title, message,
          evidence, vuln_id, cwe, package_name, installed_version, fixed_version, fingerprint, baseline_status, validation_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
      [
        organizationId, reviewRunId, f.tool, JSON.stringify(f.sources.map((s) => ({ tool: s.tool, rule_id: s.ruleId }))), f.ruleId, f.severity,
        f.category, f.filePath, f.lineStart ?? null, f.lineEnd ?? null, f.title, f.message, f.evidence, f.vulnId ?? null, f.cwe ?? null,
        f.packageName ?? null, f.installedVersion ?? null, f.fixedVersion ?? null, f.fingerprint, f.baseline, f.validation,
      ],
    );
  }

  await client.query(
    `UPDATE review_runs SET audit_stage = 'completed', audit_incomplete = $1, audit_coverage = $2 WHERE id = $3`,
    [
      guards.incomplete,
      JSON.stringify({
        // Cobertura de TODA la auditoría (capa 1 y capa 2), no solo de los escáneres.
        complete: !guards.incomplete,
        missing: guards.missing,
        budget_blocked: guards.budgetBlocked ?? false,
        technologies: layer1.coverage.technologies,
        suppressions: layer1.coverage.suppressions ?? {},
        scanner_config_files: layer1.coverage.scannerConfigFiles ?? [],
        new_confirmed_secrets: guards.newConfirmedSecrets,
        policy_reasons: policyReasons,
      }),
      reviewRunId,
    ],
  );
}

/** Guarda lo que hizo la capa 2 en una revisión: su resumen, la recomendación de escalamiento y la opinión sobre cada hallazgo de la
 * capa 1. Debe llamarse DESPUÉS de `saveLayer1` (que reemplaza las filas de scan_findings). */
export async function saveLayer2(client: PoolClient, reviewRunId: string, outcome: Layer2Outcome, escalatedTo: string | null): Promise<void> {
  const v = outcome.validated;
  await client.query(
    `UPDATE review_runs SET audit_layer2 = $1, audit_escalation = $2 WHERE id = $3`,
    [
      JSON.stringify({
        status: outcome.status,
        reason: outcome.reason,
        model: outcome.model,
        models: outcome.models,
        used_as_review: outcome.usedAsReview,
        escalated_to: escalatedTo,
        duration_ms: outcome.durationMs,
        usage: outcome.usage,
        change_tags: outcome.changeTags,
        omitted_findings: outcome.omittedFindings,
        groups: v?.groups ?? [],
        dismissals: v?.dismissals ?? { accepted: [], ignored: [] },
        rejected: v?.rejected ?? [],
        suspected: v?.suspected ?? [],
        own_findings: v?.findings.length ?? 0,
      }),
      JSON.stringify(outcome.escalation),
      reviewRunId,
    ],
  );
  for (const a of v?.annotations ?? []) {
    await client.query(
      `UPDATE scan_findings SET triage = $1 WHERE review_run_id = $2 AND fingerprint = $3`,
      [JSON.stringify({ ref: a.ref, group: a.group, priority: a.priority, dismissed: a.dismissed, note: a.note }), reviewRunId, a.fingerprint],
    );
  }
}

/** Para los hallazgos bloqueantes que no vienen del modelo (secretos): filas en `findings` para que el issue de seguimiento,
 * las notificaciones y la página del commit los muestren igual que el resto. */
export async function insertSecretFindings(
  client: PoolClient,
  organizationId: string,
  reviewRunId: string,
  layer1: Layer1Result,
): Promise<number> {
  const secrets = layer1.findings.filter(
    (f) => f.category === 'secret' && f.baseline !== 'preexisting' && f.validation !== 'accepted_exception' && f.validation !== 'false_positive_suspected',
  );
  for (const f of secrets) {
    await client.query(
      `INSERT INTO findings
         (organization_id, review_run_id, category, severity, file_path, line_start, line_end, title, explanation, confidence, rule_source, blocking, status)
       VALUES ($1, $2, 'security', 'critical', $3, $4, $5, $6, $7, 0.99, 'gitleaks', true, 'open')`,
      [
        organizationId, reviewRunId, f.filePath, f.lineStart ?? null, f.lineEnd ?? null, f.title,
        `${f.message}. El valor no se muestra. Rota la credencial de inmediato (ya quedó expuesta en el historial de git) y retírala del código.`,
      ],
    );
  }
  return secrets.length;
}

/** Lo que la capa 1 de una revisión ya guardada le impone al veredicto (usado al recalcular tras aclaraciones o reconsideraciones). */
export async function loadAuditGuards(client: PoolClient, reviewRunId: string): Promise<AuditGuards> {
  const { rows } = await client.query(
    `SELECT rr.audit_incomplete, rr.audit_coverage,
            (SELECT count(*)::int FROM scan_findings sf
              WHERE sf.review_run_id = rr.id AND sf.category = 'secret' AND sf.baseline_status <> 'preexisting'
                AND sf.validation_status NOT IN ('accepted_exception', 'false_positive_suspected')) AS new_secrets
     FROM review_runs rr WHERE rr.id = $1`,
    [reviewRunId],
  );
  const row = rows[0];
  return {
    incomplete: Boolean(row?.audit_incomplete),
    missing: row?.audit_coverage?.missing ?? [],
    newConfirmedSecrets: row?.new_secrets ?? 0,
    budgetBlocked: Boolean(row?.audit_coverage?.budget_blocked),
  };
}
