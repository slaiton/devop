import { Injectable, Logger } from '@nestjs/common';
import { withTenant } from '@devsentinel/database';
import { buildGithubAdapterForInstallation } from '@devsentinel/github-apps';
import type { ReconsiderJobPayload } from '@devsentinel/event-contracts';
import { upsertFindingsIssue } from '@devsentinel/issue-content';
import { createLlmRouter } from '../../common/llmRouter.factory';
import { checkConclusion, loadGateConfig, recomputeGateDecision } from '../../common/gate';

@Injectable()
export class ReconsiderService {
  private readonly logger = new Logger(ReconsiderService.name);

  async process(payload: ReconsiderJobPayload): Promise<void> {
    const llm = await createLlmRouter();

    await withTenant(payload.organizationId, async (client) => {
      const { rows: findingRows } = await client.query('SELECT * FROM findings WHERE id = $1', [payload.findingId]);
      const finding = findingRows[0];
      if (!finding) {
        this.logger.warn(`finding ${payload.findingId} not found, skipping reconsideration`);
        return;
      }

      const { rows: runRows } = await client.query(
        `SELECT rr.commit_sha, rr.quality_score, rr.risk_level, rr.gate_decision, rr.pull_request_id,
                rr.branch, rr.summary, r.full_name, gi.installation_id, pr.github_pr_number
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
      const gitAdapter = await buildGithubAdapterForInstallation(client, installationId);

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

      const config = await loadGateConfig(client, payload.organizationId, payload.repositoryId);
      const newGateDecision = await recomputeGateDecision(
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
        const conclusion = checkConclusion(newGateDecision);
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

      // Siempre, no solo si cambió el veredicto: reconsiderar un finding puede
      // sacarlo del set de bloqueantes aunque el gate_decision general no cambie.
      // Un fallo acá no debe tumbar la reconsideración ya aplicada; solo se loguea.
      try {
        await upsertFindingsIssue(client, gitAdapter, {
          organizationId: payload.organizationId,
          repositoryId: payload.repositoryId,
          installationId,
          owner,
          repo,
          repositoryFullName: run.full_name,
          pullRequestId: run.pull_request_id,
          pullRequestNumber: run.github_pr_number ?? null,
          branch: run.branch,
          commitSha: run.commit_sha,
          reviewRunId: payload.reviewRunId,
          reviewRun: {
            gate_decision: newGateDecision,
            quality_score: result.updated_quality_score,
            risk_level: result.updated_risk_level,
            summary: run.summary,
          },
          trigger: 'reconsideration',
          resolutionContext: `comentario: "${payload.comment}" — ${result.justification}`,
        });
      } catch (err) {
        this.logger.error(
          `no se pudo sincronizar el issue de hallazgos del review run ${payload.reviewRunId}: ${(err as Error).message}`,
          (err as Error).stack,
        );
      }
    });
  }
}
