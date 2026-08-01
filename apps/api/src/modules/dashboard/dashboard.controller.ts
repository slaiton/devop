import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
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

  @Get('repositories/:repositoryId/pushes')
  listPushes(@CurrentOrg() orgId: string, @Param('repositoryId') repositoryId: string) {
    return this.dashboardService.listPushes(orgId, repositoryId);
  }

  @Post('repositories/:repositoryId/pull-requests/:pullRequestId/merge')
  mergePullRequest(
    @CurrentOrg() orgId: string,
    @Param('repositoryId') repositoryId: string,
    @Param('pullRequestId') pullRequestId: string,
  ) {
    return this.dashboardService.mergePullRequest(orgId, repositoryId, pullRequestId);
  }

  @Get('review-runs/:reviewRunId')
  getReviewRun(@CurrentOrg() orgId: string, @Param('reviewRunId') reviewRunId: string) {
    return this.dashboardService.getReviewRun(orgId, reviewRunId);
  }
}
