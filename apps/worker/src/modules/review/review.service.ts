import { Inject, Injectable } from '@nestjs/common';
import { withTenant } from '@devsentinel/database';
import type { GitProviderPort } from '@devsentinel/git-providers';
import type { LlmPort, ProjectProfile, ReviewResult } from '@devsentinel/llm-port';
import type { ReviewJobPayload } from '@devsentinel/event-contracts';
import { RepoCheckoutService } from './repoCheckout.service';
import { StaticAnalysisService } from './staticAnalysis.service';
import { RagContextService } from './ragContext.service';
import { GIT_PROVIDER_PORT, LLM_PORT } from './tokens';

interface QualityGateConfig {
  min_coverage_pct: number;
  block_on_risk_level: 'medium' | 'high';
  block_on_secret: boolean;
}

const DEFAULT_GATE_CONFIG: QualityGateConfig = {
  min_coverage_pct: 0,
  block_on_risk_level: 'high',
  block_on_secret: true,
};

@Injectable()
export class ReviewService {
  constructor(
    @Inject(GIT_PROVIDER_PORT) private readonly gitAdapter: GitProviderPort,
    @Inject(LLM_PORT) private readonly llm: LlmPort,
    private readonly checkout: RepoCheckoutService,
    private readonly staticAnalysis: StaticAnalysisService,
    private readonly ragContext: RagContextService,
  ) {}

  async runReview(payload: ReviewJobPayload): Promise<void> {
    try {
      const diff = payload.pullNumber
        ? await this.gitAdapter.getPullRequestDiff({
            installationId: payload.installationId,
            owner: payload.owner,
            repo: payload.repo,
            pullNumber: payload.pullNumber,
          })
        : await this.gitAdapter.getCommitDiff({
            installationId: payload.installationId,
            owner: payload.owner,
            repo: payload.repo,
            commitSha: payload.commitSha,
          });

      const installationToken = await this.gitAdapter.getInstallationToken(payload.installationId);

      const { staticFindings, retrievedContext } = await this.checkout.withCheckout(
        {
          owner: payload.owner,
          repo: payload.repo,
          commitSha: payload.commitSha,
          installationToken,
        },
        async (checkoutPath) => {
          const findings = await this.staticAnalysis.run(checkoutPath);
          const context = await this.ragContext.indexAndRetrieve(
            payload.organizationId,
            payload.repositoryId,
            checkoutPath,
            diff,
          );
          return { staticFindings: findings, retrievedContext: context };
        },
      );

      const projectProfile = await this.getProjectProfile(payload.organizationId, payload.repositoryId);

      const result = await this.llm.reviewDiff({
        repositoryFullName: `${payload.owner}/${payload.repo}`,
        commitSha: payload.commitSha,
        diff,
        staticFindings,
        retrievedContext,
        projectProfile,
      });

      const config = await this.getQualityGateConfig(payload.organizationId, payload.repositoryId);
      const shouldBlock = this.evaluateShouldBlock(config, result);

      await this.persistResult(payload, result, shouldBlock);
      await this.publishToGithub(payload, result, shouldBlock);
    } catch (err) {
      await this.markFailed(payload, (err as Error).message);
      throw err;
    }
  }

  private evaluateShouldBlock(config: QualityGateConfig, result: ReviewResult): boolean {
    const hasSecretFinding = result.findings.some((f) => f.category === 'security' && /secret|credential|token/i.test(f.title));
    const blockingRiskLevels = config.block_on_risk_level === 'medium' ? ['medium', 'high'] : ['high'];
    return (config.block_on_secret && hasSecretFinding) || blockingRiskLevels.includes(result.risk_level);
  }

  private async persistResult(payload: ReviewJobPayload, result: ReviewResult, shouldBlock: boolean): Promise<void> {
    await withTenant(payload.organizationId, async (client) => {
      await client.query(
        `UPDATE review_runs
         SET status = 'completed', quality_score = $1, risk_level = $2, summary = $3,
             gate_decision = $4, completed_at = now()
         WHERE id = $5`,
        [result.quality_score, result.risk_level, result.summary, shouldBlock ? 'no_apto' : 'apto', payload.reviewRunId],
      );

      for (const finding of result.findings) {
        const blocking = shouldBlock && (finding.severity === 'critical' || finding.severity === 'high');
        await client.query(
          `INSERT INTO findings
             (organization_id, review_run_id, category, severity, file_path, line_start, line_end, title, explanation, suggested_fix, confidence, rule_source, blocking)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'llm', $12)`,
          [
            payload.organizationId,
            payload.reviewRunId,
            finding.category,
            finding.severity,
            finding.file_path,
            finding.line_start ?? null,
            finding.line_end ?? null,
            finding.title,
            finding.explanation,
            finding.suggested_fix ? JSON.stringify(finding.suggested_fix) : null,
            finding.confidence,
            blocking,
          ],
        );
      }
    });
  }

  private async publishToGithub(payload: ReviewJobPayload, result: ReviewResult, shouldBlock: boolean): Promise<void> {
    if (payload.pullNumber) {
      for (const finding of result.findings) {
        if (!finding.line_start) continue;
        await this.gitAdapter.postReviewComment({
          installationId: payload.installationId,
          owner: payload.owner,
          repo: payload.repo,
          pullNumber: payload.pullNumber,
          commitSha: payload.commitSha,
          filePath: finding.file_path,
          line: finding.line_start,
          body: `**[${finding.severity.toUpperCase()}] ${finding.title}**\n\n${finding.explanation}`,
        });
      }

      await this.gitAdapter.postSummaryComment({
        installationId: payload.installationId,
        owner: payload.owner,
        repo: payload.repo,
        pullNumber: payload.pullNumber,
        body: [
          '### DevSentinel AI Review',
          '',
          `**Quality score:** ${result.quality_score}/100`,
          `**Risk level:** ${result.risk_level}`,
          '',
          result.summary,
        ].join('\n'),
      });
    }

    await this.gitAdapter.setCheckRunStatus({
      installationId: payload.installationId,
      owner: payload.owner,
      repo: payload.repo,
      commitSha: payload.commitSha,
      conclusion: shouldBlock ? 'failure' : 'success',
      title: shouldBlock ? 'Bloqueado por DevSentinel AI' : 'Aprobado por DevSentinel AI',
      summary: result.summary,
    });
  }

  private async getProjectProfile(organizationId: string, repositoryId: string): Promise<ProjectProfile | undefined> {
    return withTenant(organizationId, async (client) => {
      const { rows } = await client.query(
        `SELECT language, framework, framework_version, runtime, database, architecture_style, testing_strategy, notes
         FROM project_profiles
         WHERE repository_id = $1`,
        [repositoryId],
      );
      const row = rows[0];
      if (!row) return undefined;
      return {
        language: row.language,
        framework: row.framework,
        frameworkVersion: row.framework_version,
        runtime: row.runtime,
        database: row.database,
        architectureStyle: row.architecture_style,
        testingStrategy: row.testing_strategy,
        notes: row.notes,
      };
    });
  }

  private async getQualityGateConfig(organizationId: string, repositoryId: string): Promise<QualityGateConfig> {
    return withTenant(organizationId, async (client) => {
      const { rows } = await client.query(
        `SELECT min_coverage_pct, block_on_risk_level, block_on_secret
         FROM quality_gate_configs
         WHERE organization_id = $1 AND (repository_id = $2 OR repository_id IS NULL)
         ORDER BY repository_id NULLS LAST
         LIMIT 1`,
        [organizationId, repositoryId],
      );
      return rows[0] ?? DEFAULT_GATE_CONFIG;
    });
  }

  private async markFailed(payload: ReviewJobPayload, message: string): Promise<void> {
    await withTenant(payload.organizationId, async (client) => {
      await client.query(
        `UPDATE review_runs SET status = 'failed', error_message = $1, completed_at = now() WHERE id = $2`,
        [message, payload.reviewRunId],
      );
    });
  }
}
