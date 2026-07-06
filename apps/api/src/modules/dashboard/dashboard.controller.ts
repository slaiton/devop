import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/jwtAuth.guard';
import { CurrentOrg } from '../../common/currentOrg.decorator';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
@UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('repositories')
  listRepositories(@CurrentOrg() orgId: string) {
    return this.dashboardService.listRepositories(orgId);
  }

  @Get('repositories/:repositoryId/pull-requests')
  listPullRequests(@CurrentOrg() orgId: string, @Param('repositoryId') repositoryId: string) {
    return this.dashboardService.listPullRequests(orgId, repositoryId);
  }

  @Get('review-runs/:reviewRunId')
  getReviewRun(@CurrentOrg() orgId: string, @Param('reviewRunId') reviewRunId: string) {
    return this.dashboardService.getReviewRun(orgId, reviewRunId);
  }
}
