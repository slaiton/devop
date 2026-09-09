import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/jwtAuth.guard';
import { RolesGuard } from '../../common/roles.guard';
import { Roles } from '../../common/roles.decorator';
import { CurrentOrg } from '../../common/currentOrg.decorator';
import { CurrentUser } from '../../common/currentUser.decorator';
import { CurrentRole } from '../../common/currentRole.decorator';
import { PullRequestsService } from './pull-requests.service';

@Controller('pull-requests')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PullRequestsController {
  constructor(private readonly pullRequestsService: PullRequestsService) {}

  @Post('from-push')
  @Roles('admin')
  createFromPush(@CurrentOrg() orgId: string, @Body() body: { repositoryId: string; reviewRunId: string }) {
    return this.pullRequestsService.createFromPush(orgId, body.repositoryId, body.reviewRunId);
  }

  @Get('repository/:repositoryId')
  listForRepository(
    @CurrentOrg() orgId: string,
    @CurrentUser() userId: string,
    @CurrentRole() role: string,
    @Param('repositoryId') repositoryId: string,
  ) {
    return this.pullRequestsService.listForRepository(orgId, repositoryId, { userId, role });
  }

  @Get(':id')
  getById(
    @CurrentOrg() orgId: string,
    @CurrentUser() userId: string,
    @CurrentRole() role: string,
    @Param('id') id: string,
  ) {
    return this.pullRequestsService.getById(orgId, id, { userId, role });
  }

  @Get(':id/status')
  getStatus(
    @CurrentOrg() orgId: string,
    @CurrentUser() userId: string,
    @CurrentRole() role: string,
    @Param('id') id: string,
  ) {
    return this.pullRequestsService.getStatus(orgId, id, { userId, role });
  }

  @Get(':id/analysis')
  getAnalysis(
    @CurrentOrg() orgId: string,
    @CurrentUser() userId: string,
    @CurrentRole() role: string,
    @Param('id') id: string,
  ) {
    return this.pullRequestsService.getAnalysis(orgId, id, { userId, role });
  }

  @Post(':id/validate-merge')
  @Roles('admin')
  validateMerge(@CurrentOrg() orgId: string, @Param('id') id: string) {
    return this.pullRequestsService.validateMerge(orgId, id);
  }

  @Post(':id/merge')
  @Roles('admin')
  merge(@CurrentOrg() orgId: string, @Param('id') id: string) {
    return this.pullRequestsService.merge(orgId, id);
  }
}
