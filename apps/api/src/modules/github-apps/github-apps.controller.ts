import { Body, Controller, Delete, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../common/jwtAuth.guard';
import { RolesGuard } from '../../common/roles.guard';
import { Roles } from '../../common/roles.decorator';
import { CurrentOrg } from '../../common/currentOrg.decorator';
import { GithubAppsService, type CreateGithubAppInput } from './github-apps.service';

@Controller('github-apps')
export class GithubAppsController {
  constructor(private readonly service: GithubAppsService) {}

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  list(@CurrentOrg() orgId: string) {
    return this.service.list(orgId);
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  create(@CurrentOrg() orgId: string, @Body() body: CreateGithubAppInput) {
    return this.service.create(orgId, body);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  remove(@CurrentOrg() orgId: string, @Param('id') id: string) {
    return this.service.remove(orgId, id);
  }

  @Get(':id/installations')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  listInstallations(@CurrentOrg() orgId: string, @Param('id') id: string) {
    return this.service.listInstallations(orgId, id);
  }

  @Post('installations/:installationRowId/sync')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  syncRepositories(@CurrentOrg() orgId: string, @Param('installationRowId') installationRowId: string) {
    return this.service.syncRepositories(orgId, installationRowId);
  }

  @Get(':id/connect')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  async connect(@CurrentOrg() orgId: string, @Param('id') id: string, @Res() res: Response): Promise<void> {
    const url = await this.service.buildConnectUrl(orgId, id);
    res.redirect(url);
  }

  // Público a propósito: GitHub redirige el navegador acá directo tras instalar la App,
  // sin pasar por nuestra sesión — la autorización real viene del `state` firmado (ver
  // GithubAppsService.handleInstallCallback).
  @Get('callback')
  async callback(
    @Query('state') state: string | undefined,
    @Query('installation_id') installationId: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const { redirectPath } = await this.service.handleInstallCallback(
      state,
      installationId ? Number(installationId) : undefined,
    );
    res.redirect(`${process.env.PUBLIC_WEB_ORIGIN ?? ''}${redirectPath}`);
  }
}
