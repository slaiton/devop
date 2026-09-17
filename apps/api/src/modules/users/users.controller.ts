import { Body, Controller, Delete, Get, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/jwtAuth.guard';
import { RolesGuard } from '../../common/roles.guard';
import { Roles } from '../../common/roles.decorator';
import { CurrentOrg } from '../../common/currentOrg.decorator';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // Público a propósito, igual que system-settings/bootstrap: solo funciona una vez,
  // mientras no exista ninguna organización todavía.
  @Post('bootstrap-first-admin')
  bootstrapFirstAdmin(
    @Body() body: { githubAccountLogin: string; organizationName?: string; adminEmail: string; adminName?: string },
  ) {
    return this.usersService.bootstrapFirstAdmin(body);
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  list(@CurrentOrg() orgId: string) {
    return this.usersService.list(orgId);
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  create(@CurrentOrg() orgId: string, @Body() body: { email: string; name?: string; role: string }) {
    return this.usersService.create(orgId, body);
  }

  @Patch(':userId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  update(@CurrentOrg() orgId: string, @Param('userId') userId: string, @Body() body: { name?: string; role?: string }) {
    return this.usersService.update(orgId, userId, body);
  }

  @Delete(':userId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  remove(@CurrentOrg() orgId: string, @Param('userId') userId: string) {
    return this.usersService.remove(orgId, userId);
  }

  @Put(':userId/repositories')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  setRepoAccess(
    @CurrentOrg() orgId: string,
    @Param('userId') userId: string,
    @Body() body: { repositoryIds: string[] },
  ) {
    return this.usersService.setRepoAccess(orgId, userId, body.repositoryIds ?? []);
  }

  @Get('developers/unlinked')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  listUnlinkedDevelopers(@CurrentOrg() orgId: string) {
    return this.usersService.listUnlinkedDevelopers(orgId);
  }

  @Post(':userId/developers/:developerId/link')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  linkDeveloper(
    @CurrentOrg() orgId: string,
    @Param('userId') userId: string,
    @Param('developerId') developerId: string,
  ) {
    return this.usersService.linkDeveloper(orgId, userId, developerId);
  }
}
