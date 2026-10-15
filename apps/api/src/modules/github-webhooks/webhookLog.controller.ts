import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/jwtAuth.guard';
import { RolesGuard } from '../../common/roles.guard';
import { Roles } from '../../common/roles.decorator';
import { CurrentOrg } from '../../common/currentOrg.decorator';
import { WebhookLogService, type DeliveryOutcome } from './webhookLog.service';

@Controller('webhook-log')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class WebhookLogController {
  constructor(private readonly log: WebhookLogService) {}

  @Get()
  list(
    @CurrentOrg() orgId: string,
    @Query() query: { app?: string; outcome?: DeliveryOutcome; event?: string; before?: string; limit?: string },
  ) {
    return this.log.list(orgId, { ...query, limit: query.limit ? Number(query.limit) : undefined });
  }

  @Get('summary')
  summary(@CurrentOrg() orgId: string) {
    return this.log.summary(orgId);
  }
}
