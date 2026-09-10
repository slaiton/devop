import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/jwtAuth.guard';
import { RolesGuard } from '../../common/roles.guard';
import { Roles } from '../../common/roles.decorator';
import { SystemSettingsService, type SystemSettingsUpdateInput } from './system-settings.service';

@Controller('system-settings')
export class SystemSettingsController {
  constructor(private readonly service: SystemSettingsService) {}

  // Públicos a propósito: antes de configurar GitHub OAuth por primera vez, nadie
  // puede loguearse todavía — bootstrap() se autobloquea apenas ya hay algo guardado.
  @Get('status')
  getStatus() {
    return this.service.getStatus();
  }

  @Post('bootstrap')
  bootstrap(@Body() body: SystemSettingsUpdateInput) {
    return this.service.bootstrap(body);
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  get() {
    return this.service.getMasked();
  }

  @Patch()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  update(@Body() body: SystemSettingsUpdateInput) {
    return this.service.update(body);
  }
}
