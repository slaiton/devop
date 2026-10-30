import type { PoolClient } from 'pg';
import type { AuditGuards } from './policy';
import type { Layer1Result } from './types';

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
        complete: layer1.coverage.complete,
        missing: layer1.coverage.missing,
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
  };
}
