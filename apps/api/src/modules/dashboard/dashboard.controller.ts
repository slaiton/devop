import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/jwtAuth.guard';
import { RolesGuard } from '../../common/roles.guard';
import { Roles } from '../../common/roles.decorator';
import { CurrentOrg } from '../../common/currentOrg.decorator';
import { CurrentUser } from '../../common/currentUser.decorator';
import { CurrentRole } from '../../common/currentRole.decorator';
import { AuthService } from '../auth/auth.service';
import { DashboardService } from './dashboard.service';

interface UpdateRepositorySettingsBody {
  monitoredBranches?: string[];
  promotionSourceBranch?: string;
  promotionTargetBranch?: string;
  autoCreatePrOnPush?: boolean;
}

interface UpdateProjectProfileBody {
  language?: string;
  framework?: string;
  frameworkVersion?: string;
  runtime?: string;
  database?: string;
  architectureStyle?: string;
  testingStrategy?: string;
  notes?: string;
  mandatoryRules?: string[];
  securityRules?: string[];
  conventions?: string[];
  migrationsPolicy?: string;
  compatibilityNotes?: string;
}

@Controller('dashboard')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DashboardController {
  constructor(
    private readonly dashboardService: DashboardService,
    private readonly authService: AuthService,
  ) {}

  // ---- Vista personal ("usuario") — sin @Roles, abierta a admin y developer ----

  @Get('me/profile')
  getMyProfile(@CurrentOrg() orgId: string, @CurrentUser() userId: string) {
    return this.dashboardService.getMyProfile(orgId, userId);
  }

  @Get('me/reviews')
  getMyReviews(@CurrentOrg() orgId: string, @CurrentUser() userId: string) {
    return this.dashboardService.getMyReviews(orgId, userId);
  }

  @Get('review-runs/:reviewRunId')
  getReviewRun(
    @CurrentOrg() orgId: string,
    @CurrentUser() userId: string,
    @CurrentRole() role: string,
    @Param('reviewRunId') reviewRunId: string,
  ) {
    return this.dashboardService.getReviewRun(orgId, reviewRunId, { userId, role });
  }

  @Get('review-runs/:reviewRunId/diff')
  async getReviewRunDiff(
    @CurrentOrg() orgId: string,
    @CurrentUser() userId: string,
    @CurrentRole() role: string,
    @Param('reviewRunId') reviewRunId: string,
  ) {
    const diff = await this.dashboardService.getReviewRunDiff(orgId, reviewRunId, { userId, role });
    return { diff };
  }

  // ---- Gestión de equipo (solo admin) ----

  @Get('team')
  @Roles('admin')
  listTeam(@CurrentOrg() orgId: string) {
    return this.dashboardService.listTeam(orgId);
  }

  @Post('team/invite')
  @Roles('admin')
  inviteTeamMember(@CurrentOrg() orgId: string, @Body() body: { githubLogin: string }) {
    return this.authService.inviteUser(orgId, body.githubLogin);
  }

  // ---- Todo lo demás es gestión de repos/organización — solo admin ----

  @Get('repositories')
  @Roles('admin')
  listRepositories(@CurrentOrg() orgId: string) {
    return this.dashboardService.listRepositories(orgId);
  }

  @Get('repositories/:repositoryId/settings')
  @Roles('admin')
  getRepositorySettings(@CurrentOrg() orgId: string, @Param('repositoryId') repositoryId: string) {
    return this.dashboardService.getRepositorySettings(orgId, repositoryId);
  }

  @Patch('repositories/:repositoryId/settings')
  @Roles('admin')
  updateRepositorySettings(
    @CurrentOrg() orgId: string,
    @Param('repositoryId') repositoryId: string,
    @Body() body: UpdateRepositorySettingsBody,
  ) {
    return this.dashboardService.updateRepositorySettings(orgId, repositoryId, body);
  }

  @Get('repositories/:repositoryId/project-profile')
  @Roles('admin')
  getProjectProfile(@CurrentOrg() orgId: string, @Param('repositoryId') repositoryId: string) {
    return this.dashboardService.getProjectProfile(orgId, repositoryId);
  }

  @Patch('repositories/:repositoryId/project-profile')
  @Roles('admin')
  updateProjectProfile(
    @CurrentOrg() orgId: string,
    @Param('repositoryId') repositoryId: string,
    @Body() body: UpdateProjectProfileBody,
  ) {
    return this.dashboardService.updateProjectProfile(orgId, repositoryId, body);
  }

  @Post('repositories/:repositoryId/review-runs/:reviewRunId/notify')
  @Roles('admin')
  notifyReviewRun(
    @CurrentOrg() orgId: string,
    @Param('repositoryId') repositoryId: string,
    @Param('reviewRunId') reviewRunId: string,
  ) {
    return this.dashboardService.notifyReviewRun(orgId, repositoryId, reviewRunId);
  }

  @Get('repositories/:repositoryId/pull-requests')
  @Roles('admin')
  listPullRequests(@CurrentOrg() orgId: string, @Param('repositoryId') repositoryId: string) {
    return this.dashboardService.listPullRequests(orgId, repositoryId);
  }

  @Get('repositories/:repositoryId/pushes')
  @Roles('admin')
  listPushes(@CurrentOrg() orgId: string, @Param('repositoryId') repositoryId: string) {
    return this.dashboardService.listPushes(orgId, repositoryId);
  }

  @Post('repositories/:repositoryId/pull-requests/:pullRequestId/merge')
  @Roles('admin')
  mergePullRequest(
    @CurrentOrg() orgId: string,
    @Param('repositoryId') repositoryId: string,
    @Param('pullRequestId') pullRequestId: string,
  ) {
    return this.dashboardService.mergePullRequest(orgId, repositoryId, pullRequestId);
  }

  @Get('repositories/:repositoryId/promotions')
  @Roles('admin')
  listPromotions(@CurrentOrg() orgId: string, @Param('repositoryId') repositoryId: string) {
    return this.dashboardService.listPromotions(orgId, repositoryId);
  }

  @Post('repositories/:repositoryId/promotions')
  @Roles('admin')
  requestPromotion(
    @CurrentOrg() orgId: string,
    @CurrentUser() userId: string,
    @Param('repositoryId') repositoryId: string,
    @Body() body: { reviewRunId: string },
  ) {
    return this.dashboardService.requestPromotion(orgId, repositoryId, body.reviewRunId, userId);
  }

  @Post('promotions/:promotionId/approve')
  @Roles('admin')
  approvePromotion(@CurrentOrg() orgId: string, @CurrentUser() userId: string, @Param('promotionId') promotionId: string) {
    return this.dashboardService.decidePromotion(orgId, promotionId, userId, 'approved');
  }

  @Post('promotions/:promotionId/reject')
  @Roles('admin')
  rejectPromotion(
    @CurrentOrg() orgId: string,
    @CurrentUser() userId: string,
    @Param('promotionId') promotionId: string,
    @Body() body: { notes?: string },
  ) {
    return this.dashboardService.decidePromotion(orgId, promotionId, userId, 'rejected', body?.notes);
  }

  @Get('developers')
  @Roles('admin')
  listDevelopers(@CurrentOrg() orgId: string) {
    return this.dashboardService.listDevelopers(orgId);
  }

  @Get('overview')
  @Roles('admin')
  getOverview(@CurrentOrg() orgId: string) {
    return this.dashboardService.getOverview(orgId);
  }
}
