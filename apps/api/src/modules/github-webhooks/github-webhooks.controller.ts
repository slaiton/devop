import { Body, Controller, Headers, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { GithubWebhooksService } from './github-webhooks.service';

@Controller('webhooks/github')
export class GithubWebhooksController {
  constructor(private readonly service: GithubWebhooksService) {}

  @Post()
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Headers('x-github-event') event: string | undefined,
    @Body() body: Record<string, unknown>,
  ): Promise<{ received: true }> {
    if (!req.rawBody || !this.service.verifySignature(req.rawBody, signature)) {
      throw new UnauthorizedException('invalid webhook signature');
    }
    await this.service.handleEvent(event ?? 'unknown', body);
    return { received: true };
  }
}
