import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { getPool, withTenant } from '@devsentinel/database';
import { GithubAdapter } from '@devsentinel/git-providers';
import { OpenAiCompatibleLlmAdapter, embedLocally } from '@devsentinel/llm-port';
import { getSystemSettings } from '@devsentinel/settings';
import type { ReconsiderJobPayload } from '@devsentinel/event-contracts';

interface QualityGateConfig {
  block_on_risk_level: 'medium' | 'high';
  block_on_secret: boolean;
}

const DEFAULT_GATE_CONFIG: QualityGateConfig = { block_on_risk_level: 'high', block_on_secret: true };
const HARD_BLOCK_CATEGORIES = new Set(['security', 'architecture', 'database', 'regression']);

@Injectable()
export class ReconsiderService {
  private readonly logger = new Logger(ReconsiderService.name);

  async process(payload: ReconsiderJobPayload): Promise<void> {
    const settings = await getSystemSettings(getPool());
    const gitAdapter = new GithubAdapter({
      appId: settings?.githubAppId ?? '',
      privateKey: (settings?.githubAppPrivateKey ?? '').replace(/\\n/g, '\n'),
      webhookSecret: settings?.githubAppWebhookSecret ?? '',
    });
    const llm = new OpenAiCompatibleLlmAdapter(
      settings?.llmModel ?? '',
      settings?.llmProviderBaseUrl ?? '',
      settings?.llmProviderApiKey ?? '',
      embedLocally,
    );

    await withTenant(payload.organizationId, async (client) => {
      const { rows: findingRows } = await client.query('SELECT * FROM findings WHERE id = $1', [payload.findingId]);
      const finding = findingRows[0];
      if (!finding) {
        this.logger.warn(`finding ${payload.findingId} not found, skipping reconsideration`);
        return;
      }

      const { rows: runRows } = await client.query(
        `SELECT rr.commit_sha, rr.quality_score, rr.risk_level, rr.gate_decision, rr.pull_request_id,
                r.full_name, gi.installation_id, pr.github_pr_number
         FROM review_runs rr
         JOIN repositories r ON r.id = rr.repository_id
         JOIN github_installations gi ON gi.id = r.github_installation_id
         LEFT JOIN pull_requests pr ON pr.id = rr.pull_request_id
         WHERE rr.id = $1`,
        [payload.reviewRunId],
      );
      const run = runRows[0];
      if (!run) {
        this.logger.warn(`review run ${payload.reviewRunId} not found, skipping reconsideration`);
        return;
      }

      const [owner, repo] = String(run.full_name).split('/');
      const installationId = Number(run.installation_id);

      const diff = run.github_pr_number
        ? await gitAdapter.getPullRequestDiff({ installationId, owner, repo, pullNumber: run.github_pr_number })
        : await gitAdapter.getCommitDiff({ installationId, owner, repo, commitSha: run.commit_sha });

      const result = await llm.reconsiderFinding({
        repositoryFullName: run.full_name,
        commitSha: run.commit_sha,
        diff,
        finding: {
          category: finding.category,
          severity: finding.severity,
          file_path: finding.file_path,
          line_start: finding.line_start,
          line_end: finding.line_end,
          title: finding.title,
          explanation: finding.explanation,
          confidence: Number(finding.confidence ?? 0.5),
          violated_rule: finding.violated_rule,
        },
        humanComment: payload.comment,
        currentQualityScore: run.quality_score ?? 0,
        currentRiskLevel: run.risk_level ?? 'medium',
      });

      await client.query(
        `UPDATE findings
         SET status = $1,
             explanation = explanation || E'\\n\\nReconsiderado: ' || $2,
             resolution_comment = $3, resolved_by = $4, resolved_at = now()
         WHERE id = $5`,
        [result.status, result.justification, payload.comment, payload.requestedBy, payload.findingId],
      );

      const config = await this.getQualityGateConfig(client, payload.organizationId, payload.repositoryId);
      const newGateDecision = await this.recomputeGateDecision(
        client,
        payload.reviewRunId,
        result.updated_risk_level,
        result.updated_quality_score,
        config,
      );

      await client.query(
        `UPDATE review_runs SET quality_score = $1, risk_level = $2, gate_decision = $3 WHERE id = $4`,
        [result.updated_quality_score, result.updated_risk_level, newGateDecision, payload.reviewRunId],
      );

      if (newGateDecision !== run.gate_decision) {
        const conclusion = newGateDecision === 'apto' ? 'success' : newGateDecision === 'requiere_revision' ? 'neutral' : 'failure';
        const title =
          newGateDecision === 'apto'
            ? 'Aprobado por DevSentinel AI (reconsiderado)'
            : newGateDecision === 'requiere_revision'
              ? 'Requiere revisión humana — DevSentinel AI (reconsiderado)'
              : 'Bloqueado por DevSentinel AI (reconsiderado)';
        await gitAdapter.setCheckRunStatus({
          installationId,
          owner,
          repo,
          commitSha: run.commit_sha,
          conclusion,
          title,
          summary: result.justification,
        });
      }
    });
  }

  private async getQualityGateConfig(client: PoolClient, organizationId: string, repositoryId: string): Promise<QualityGateConfig> {
    const { rows } = await client.query(
      `SELECT block_on_risk_level, block_on_secret
       FROM quality_gate_configs
       WHERE organization_id = $1 AND (repository_id = $2 OR repository_id IS NULL)
       ORDER BY repository_id NULLS LAST
       LIMIT 1`,
      [organizationId, repositoryId],
    );
    return rows[0] ?? DEFAULT_GATE_CONFIG;
  }

  private async recomputeGateDecision(
    client: PoolClient,
    reviewRunId: string,
    riskLevel: 'low' | 'medium' | 'high',
    qualityScore: number,
    config: QualityGateConfig,
  ): Promise<'apto' | 'requiere_revision' | 'no_apto'> {
    const { rows: openFindings } = await client.query(
      `SELECT category, severity, title FROM findings WHERE review_run_id = $1 AND status = 'open'`,
      [reviewRunId],
    );

    const hasHardBlockingFinding = openFindings.some(
      (f: any) => f.severity === 'critical' && HARD_BLOCK_CATEGORIES.has(f.category),
    );
    if (hasHardBlockingFinding) return 'no_apto';

    const hasSecretFinding = openFindings.some(
      (f: any) => f.category === 'security' && /secret|credential|token/i.test(f.title),
    );
    if (config.block_on_secret && hasSecretFinding) return 'no_apto';

    const blockingRiskLevels = config.block_on_risk_level === 'medium' ? ['medium', 'high'] : ['high'];
    if (blockingRiskLevels.includes(riskLevel)) return 'no_apto';

    if (riskLevel === 'high') return 'requiere_revision';
    if (riskLevel === 'medium' && qualityScore < 70) return 'requiere_revision';
    return 'apto';
  }
}
