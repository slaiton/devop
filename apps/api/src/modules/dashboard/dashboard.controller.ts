import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/jwtAuth.guard';
import { CurrentOrg } from '../../common/currentOrg.decorator';
import { CurrentUser } from '../../common/currentUser.decorator';
import { DashboardService } from './dashboard.service';

interface UpdateRepositorySettingsBody {
  monitoredBranches?: string[];
  promotionSourceBranch?: string;
  promotionTargetBranch?: string;
}

@Controller('dashboard')
@UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('repositories')
  listRepositories(@CurrentOrg() orgId: string) {
    return this.dashboardService.listRepositories(orgId);
  }

  @Get('repositories/:repositoryId/settings')
  getRepositorySettings(@CurrentOrg() orgId: string, @Param('repositoryId') repositoryId: string) {
    return this.dashboardService.getRepositorySettings(orgId, repositoryId);
  }

  @Patch('repositories/:repositoryId/settings')
  updateRepositorySettings(
    @CurrentOrg() orgId: string,
    @Param('repositoryId') repositoryId: string,
    @Body() body: UpdateRepositorySettingsBody,
  ) {
    return this.dashboardService.updateRepositorySettings(orgId, repositoryId, body);
  }

  @Get('repositories/:repositoryId/project-profile')
  getProjectProfile(@CurrentOrg() orgId: string, @Param('repositoryId') repositoryId: string) {
    return this.dashboardService.getProjectProfile(orgId, repositoryId);
  }

  @Patch('repositories/:repositoryId/project-profile')
  updateProjectProfile(
    @CurrentOrg() orgId: string,
    @Param('repositoryId') repositoryId: string,
    @Body()
    body: {
      language?: string;
      framework?: string;
      frameworkVersion?: string;
      runtime?: string;
      database?: string;
      architectureStyle?: string;
      testingStrategy?: string;
      notes?: string;
    },
  ) {
    return this.dashboardService.updateProjectProfile(orgId, repositoryId, body);
  }

  @Post('repositories/:repositoryId/review-runs/:reviewRunId/notify')
  notifyReviewRun(
    @CurrentOrg() orgId: string,
    @Param('repositoryId') repositoryId: string,
    @Param('reviewRunId') reviewRunId: string,
  ) {
    return this.dashboardService.notifyReviewRun(orgId, repositoryId, reviewRunId);
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

  @Get('repositories/:repositoryId/promotions')
  listPromotions(@CurrentOrg() orgId: string, @Param('repositoryId') repositoryId: string) {
    return this.dashboardService.listPromotions(orgId, repositoryId);
  }

  @Post('repositories/:repositoryId/promotions')
  requestPromotion(
    @CurrentOrg() orgId: string,
    @CurrentUser() userId: string,
    @Param('repositoryId') repositoryId: string,
    @Body() body: { reviewRunId: string },
  ) {
    return this.dashboardService.requestPromotion(orgId, repositoryId, body.reviewRunId, userId);
  }

  @Post('promotions/:promotionId/approve')
  approvePromotion(@CurrentOrg() orgId: string, @CurrentUser() userId: string, @Param('promotionId') promotionId: string) {
    return this.dashboardService.decidePromotion(orgId, promotionId, userId, 'approved');
  }

  @Post('promotions/:promotionId/reject')
  rejectPromotion(
    @CurrentOrg() orgId: string,
    @CurrentUser() userId: string,
    @Param('promotionId') promotionId: string,
    @Body() body: { notes?: string },
  ) {
    return this.dashboardService.decidePromotion(orgId, promotionId, userId, 'rejected', body?.notes);
  }

  @Get('review-runs/:reviewRunId')
  getReviewRun(@CurrentOrg() orgId: string, @Param('reviewRunId') reviewRunId: string) {
    return this.dashboardService.getReviewRun(orgId, reviewRunId);
  }
}
