import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/jwtAuth.guard';
import { RolesGuard } from '../../common/roles.guard';
import { Roles } from '../../common/roles.decorator';
import { LlmProvidersService, type LlmProviderInput } from './llm-providers.service';
import { SystemSettingsService, type SystemSettingsUpdateInput } from './system-settings.service';

@Controller('system-settings')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class SystemSettingsController {
  constructor(
    private readonly service: SystemSettingsService,
    private readonly llm: LlmProvidersService,
  ) {}

  @Get()
  get() {
    return this.service.getMasked();
  }

  @Patch()
  update(@Body() body: SystemSettingsUpdateInput) {
    return this.service.update(body);
  }

  // ---- Agentes de IA: proveedores de LLM, su orden y el modo de reparto ----

  @Get('llm')
  getLlm() {
    return this.llm.get();
  }

  @Patch('llm/routing')
  setRouting(@Body() body: { mode?: string }) {
    return this.llm.setMode(body?.mode);
  }

  @Put('llm/order')
  reorder(@Body() body: { ids?: string[] }) {
    return this.llm.reorder(body?.ids);
  }

  @Post('llm/providers')
  createProvider(@Body() body: LlmProviderInput) {
    return this.llm.create(body ?? {});
  }

  @Patch('llm/providers/:id')
  updateProvider(@Param('id', ParseUUIDPipe) id: string, @Body() body: LlmProviderInput) {
    return this.llm.update(id, body ?? {});
  }

  @Delete('llm/providers/:id')
  removeProvider(@Param('id', ParseUUIDPipe) id: string) {
    return this.llm.remove(id);
  }

  @Post('llm/providers/:id/test')
  testProvider(@Param('id', ParseUUIDPipe) id: string) {
    return this.llm.test(id);
  }
}
