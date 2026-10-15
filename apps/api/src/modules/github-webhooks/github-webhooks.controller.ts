import { Body, Controller, Headers, Post, Req, UnauthorizedException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { GithubWebhooksService } from './github-webhooks.service';
import type { WebhookOutcome } from './webhookOutcome';
import { WebhookLogService } from './webhookLog.service';

// GitHub manda todos sus webhooks desde unas pocas IPs: limitarlos por IP los rechazaría.
@SkipThrottle()
@Controller('webhooks/github')
export class GithubWebhooksController {
  constructor(
    private readonly service: GithubWebhooksService,
    private readonly log: WebhookLogService,
  ) {}

  /** Cada petición que llega acá deja una fila en `webhook_deliveries` (aceptada, ignorada,
   * rechazada o con error): es lo que permite saber, sin entrar al servidor, si una GitHub
   * App está mandando eventos y qué se hizo con ellos. */
  @Post()
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string | undefined>,
    @Body() body: Record<string, unknown>,
  ): Promise<{ received: true }> {
    const started = Date.now();
    const event = headers['x-github-event'] ?? null;
    const githubAppId = headers['x-github-hook-installation-target-id'] ?? null;
    const common = {
      deliveryGuid: headers['x-github-delivery'] ?? null,
      event,
      githubAppId,
      sourceIp: req.ip ?? null,
      userAgent: headers['user-agent'] ?? null,
      contentType: headers['content-type'] ?? null,
      payloadBytes: req.rawBody?.length ?? null,
    };

    const verified = await this.service.verifyAndResolve(req.rawBody, headers['x-hub-signature-256'], githubAppId ?? undefined);
    if (!verified.ok) {
      await this.log.record({
        ...common,
        githubAppRowId: verified.githubAppRowId,
        organizationId: verified.organizationId,
        outcome: 'rejected',
        reason: verified.reason,
        detail: verified.detail,
        statusCode: 401,
        durationMs: Date.now() - started,
      });
      throw new UnauthorizedException('invalid webhook signature or unknown GitHub App');
    }
    const { ctx } = verified;

    // Si la App tiene el webhook como application/x-www-form-urlencoded, GitHub manda el JSON
    // dentro del campo `payload`; la firma ya se verificó sobre el cuerpo crudo.
    let payload: any = body;
    if (typeof body?.payload === 'string') {
      try {
        payload = JSON.parse(body.payload);
      } catch {
        payload = body;
      }
    }

    let outcome: WebhookOutcome;
    try {
      outcome = await this.service.handleEvent(event ?? 'unknown', payload, ctx);
    } catch (err) {
      await this.log.record({
        ...common,
        action: typeof payload?.action === 'string' ? payload.action : null,
        githubAppRowId: ctx.githubAppRowId,
        organizationId: ctx.organizationId,
        repository: payload?.repository?.full_name ?? null,
        outcome: 'error',
        reason: 'exception',
        detail: (err as Error).message,
        statusCode: 500,
        durationMs: Date.now() - started,
      });
      throw err;
    }

    await this.log.record({
      ...common,
      action: outcome.action ?? null,
      githubAppRowId: ctx.githubAppRowId,
      organizationId: ctx.organizationId,
      outcome: outcome.outcome,
      reason: outcome.reason,
      detail: outcome.detail,
      repository: outcome.repository,
      ref: outcome.ref,
      commitSha: outcome.commitSha,
      reviewRunId: outcome.reviewRunId,
      statusCode: 201,
      durationMs: Date.now() - started,
    });
    return { received: true };
  }
}
