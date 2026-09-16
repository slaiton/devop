import { Injectable, Logger } from '@nestjs/common';
import { getPool, withTenant } from '@devsentinel/database';
import { OpenAiCompatibleLlmAdapter, embedLocally } from '@devsentinel/llm-port';
import { getSystemSettings } from '@devsentinel/settings';
import type { IssueReplySuggestionJobPayload } from '@devsentinel/event-contracts';

@Injectable()
export class IssueReplyService {
  private readonly logger = new Logger(IssueReplyService.name);

  /** Genera un borrador de respuesta para un issue — nunca publica nada en GitHub, el
   * `api` marca `ai_suggested_reply_status='pending'` antes de encolar y el admin
   * publica el borrador (editado o no) como comentario aparte, vía el endpoint normal
   * de comentarios. Ningún adapter de git hace falta acá. */
  async process(payload: IssueReplySuggestionJobPayload): Promise<void> {
    const settings = await getSystemSettings(getPool());
    const llm = new OpenAiCompatibleLlmAdapter(
      settings?.llmModel ?? '',
      settings?.llmProviderBaseUrl ?? '',
      settings?.llmProviderApiKey ?? '',
      embedLocally,
    );

    await withTenant(payload.organizationId, async (client) => {
      const { rows: issueRows } = await client.query(
        `SELECT i.id, i.title, i.body, i.review_run_id, r.full_name
         FROM issues i
         JOIN repositories r ON r.id = i.repository_id
         WHERE i.id = $1`,
        [payload.issueId],
      );
      const issue = issueRows[0];
      if (!issue) {
        this.logger.warn(`issue ${payload.issueId} not found, skipping reply suggestion`);
        return;
      }

      const { rows: commentRows } = await client.query(
        `SELECT author_login, body, source FROM issue_comments
         WHERE issue_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
        [payload.issueId],
      );

      const { rows: findingRows } = issue.review_run_id
        ? await client.query(
            `SELECT category, severity, file_path, line_start, line_end, title, explanation, suggested_fix, confidence, violated_rule
             FROM findings WHERE review_run_id = $1 AND status = 'open' AND blocking = true`,
            [issue.review_run_id],
          )
        : { rows: [] };

      try {
        const result = await llm.suggestIssueReply({
          repositoryFullName: issue.full_name,
          issueTitle: issue.title,
          issueBody: issue.body,
          comments: commentRows.map((c) => ({ authorLogin: c.author_login, body: c.body, source: c.source })),
          blockingFindings: findingRows.map((f) => ({
            category: f.category,
            severity: f.severity,
            file_path: f.file_path,
            line_start: f.line_start,
            line_end: f.line_end,
            title: f.title,
            explanation: f.explanation,
            suggested_fix: f.suggested_fix,
            confidence: Number(f.confidence),
            violated_rule: f.violated_rule,
          })),
        });

        await client.query(
          `UPDATE issues SET ai_suggested_reply = $1, ai_suggested_reply_status = 'ready', ai_suggested_reply_error = NULL WHERE id = $2`,
          [result.reply, payload.issueId],
        );
      } catch (err) {
        this.logger.error(
          `no se pudo generar la sugerencia de respuesta para el issue ${payload.issueId}: ${(err as Error).message}`,
          (err as Error).stack,
        );
        await client.query(
          `UPDATE issues SET ai_suggested_reply_status = 'failed', ai_suggested_reply_error = $1 WHERE id = $2`,
          [(err as Error).message, payload.issueId],
        );
      }
    });
  }
}
