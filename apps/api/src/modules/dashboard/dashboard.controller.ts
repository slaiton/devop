import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/jwtAuth.guard';
import { RolesGuard } from '../../common/roles.guard';
import { Roles } from '../../common/roles.decorator';
import { CurrentOrg } from '../../common/currentOrg.decorator';
import { CurrentUser } from '../../common/currentUser.decorator';
import { CurrentRole } from '../../common/currentRole.decorator';
import { AuthService } from '../auth/auth.service';
import { DashboardService } from './dashboard.service';

interface UpdateRepositorySettingsBody {
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

  // ---- Vista personal ("usuario") — sin @Roles, abierta a admin y user ----

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

  // ---- Repos: lectura abierta a admin y a "user" con el repo asignado ----

  @Get('repositories')
  listRepositories(@CurrentOrg() orgId: string, @CurrentUser() userId: string, @CurrentRole() role: string) {
    return this.dashboardService.listRepositories(orgId, { userId, role });
  }

  @Get('repositories/:repositoryId/settings')
  async getRepositorySettings(
    @CurrentOrg() orgId: string,
    @CurrentUser() userId: string,
    @CurrentRole() role: string,
    @Param('repositoryId') repositoryId: string,
  ) {
    await this.dashboardService.assertRepoAccess(orgId, repositoryId, { userId, role });
    return this.dashboardService.getRepositorySettings(orgId, repositoryId);
  }

  @Get('repositories/:repositoryId/project-profile')
  async getProjectProfile(
    @CurrentOrg() orgId: string,
    @CurrentUser() userId: string,
    @CurrentRole() role: string,
    @Param('repositoryId') repositoryId: string,
  ) {
    await this.dashboardService.assertRepoAccess(orgId, repositoryId, { userId, role });
    return this.dashboardService.getProjectProfile(orgId, repositoryId);
  }

  @Get('repositories/:repositoryId/pushes')
  async listPushes(
    @CurrentOrg() orgId: string,
    @CurrentUser() userId: string,
    @CurrentRole() role: string,
    @Param('repositoryId') repositoryId: string,
  ) {
    await this.dashboardService.assertRepoAccess(orgId, repositoryId, { userId, role });
    return this.dashboardService.listPushes(orgId, repositoryId);
  }

  // ---- Acceso a repos por usuario (solo admin) ----

  @Get('repositories/:repositoryId/members')
  @Roles('admin')
  listRepositoryMembers(@CurrentOrg() orgId: string, @Param('repositoryId') repositoryId: string) {
    return this.dashboardService.listRepositoryMembers(orgId, repositoryId);
  }

  @Post('repositories/:repositoryId/members')
  @Roles('admin')
  addRepositoryMember(
    @CurrentOrg() orgId: string,
    @Param('repositoryId') repositoryId: string,
    @Body() body: { userId: string },
  ) {
    return this.dashboardService.addRepositoryMember(orgId, repositoryId, body.userId);
  }

  @Delete('repositories/:repositoryId/members/:userId')
  @Roles('admin')
  removeRepositoryMember(
    @CurrentOrg() orgId: string,
    @Param('repositoryId') repositoryId: string,
    @Param('userId') userId: string,
  ) {
    return this.dashboardService.removeRepositoryMember(orgId, repositoryId, userId);
  }

  // ---- Todo lo demás es gestión de repos/organización — solo admin ----

  @Patch('repositories/:repositoryId/settings')
  @Roles('admin')
  updateRepositorySettings(
    @CurrentOrg() orgId: string,
    @Param('repositoryId') repositoryId: string,
    @Body() body: UpdateRepositorySettingsBody,
  ) {
    return this.dashboardService.updateRepositorySettings(orgId, repositoryId, body);
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

  @Post('repositories/:repositoryId/review-runs/:reviewRunId/mark-reviewed')
  @Roles('admin')
  markReviewed(
    @CurrentOrg() orgId: string,
    @CurrentUser() userId: string,
    @Param('repositoryId') repositoryId: string,
    @Param('reviewRunId') reviewRunId: string,
  ) {
    return this.dashboardService.markReviewed(orgId, repositoryId, reviewRunId, userId);
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

  @Get('accounts')
  @Roles('admin')
  listConnectedAccounts(@CurrentOrg() orgId: string) {
    return this.dashboardService.listConnectedAccounts(orgId);
  }

  @Post('repositories/:repositoryId/review-runs/:reviewRunId/findings/:findingId/reconsider')
  @Roles('admin')
  reconsiderFinding(
    @CurrentOrg() orgId: string,
    @CurrentUser() userId: string,
    @Param('repositoryId') repositoryId: string,
    @Param('reviewRunId') reviewRunId: string,
    @Param('findingId') findingId: string,
    @Body() body: { comment: string },
  ) {
    return this.dashboardService.requestFindingReconsideration(
      orgId,
      repositoryId,
      reviewRunId,
      findingId,
      body.comment,
      userId,
    );
  }
}
