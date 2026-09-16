import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/jwtAuth.guard';
import { RolesGuard } from '../../common/roles.guard';
import { Roles } from '../../common/roles.decorator';
import { CurrentOrg } from '../../common/currentOrg.decorator';
import { CurrentUser } from '../../common/currentUser.decorator';
import { CurrentRole } from '../../common/currentRole.decorator';
import { IssuesService } from './issues.service';

@Controller('issues')
@UseGuards(JwtAuthGuard, RolesGuard)
export class IssuesController {
  constructor(private readonly issuesService: IssuesService) {}

  // ---- Lectura: abierta a admin y a "user" con el repo asignado ----

  @Get('repository/:repositoryId')
  listForRepository(
    @CurrentOrg() orgId: string,
    @CurrentUser() userId: string,
    @CurrentRole() role: string,
    @Param('repositoryId') repositoryId: string,
  ) {
    return this.issuesService.listForRepository(orgId, repositoryId, { userId, role });
  }

  @Get(':issueId')
  getById(
    @CurrentOrg() orgId: string,
    @CurrentUser() userId: string,
    @CurrentRole() role: string,
    @Param('issueId') issueId: string,
  ) {
    return this.issuesService.getById(orgId, issueId, { userId, role });
  }

  // ---- Mutaciones: solo admin ----

  @Post(':issueId/comments')
  @Roles('admin')
  postComment(
    @CurrentOrg() orgId: string,
    @CurrentUser() userId: string,
    @Param('issueId') issueId: string,
    @Body() body: { body: string },
  ) {
    return this.issuesService.postComment(orgId, issueId, body.body, userId);
  }

  @Post(':issueId/suggest-reply')
  @Roles('admin')
  suggestReply(@CurrentOrg() orgId: string, @CurrentUser() userId: string, @Param('issueId') issueId: string) {
    return this.issuesService.requestReplySuggestion(orgId, issueId, userId);
  }

  @Post('repository/:repositoryId/review-runs/:reviewRunId/sync')
  @Roles('admin')
  syncFindingsIssue(
    @CurrentOrg() orgId: string,
    @Param('repositoryId') repositoryId: string,
    @Param('reviewRunId') reviewRunId: string,
  ) {
    return this.issuesService.createOrSyncFindingsIssue(orgId, repositoryId, reviewRunId);
  }

  @Post('repository/:repositoryId/backfill')
  @Roles('admin')
  backfill(@CurrentOrg() orgId: string, @Param('repositoryId') repositoryId: string) {
    return this.issuesService.backfillIssues(orgId, repositoryId);
  }

  @Post(':issueId/close')
  @Roles('admin')
  close(@CurrentOrg() orgId: string, @Param('issueId') issueId: string) {
    return this.issuesService.closeIssue(orgId, issueId);
  }

  @Post(':issueId/reopen')
  @Roles('admin')
  reopen(@CurrentOrg() orgId: string, @Param('issueId') issueId: string) {
    return this.issuesService.reopenIssue(orgId, issueId);
  }
}
