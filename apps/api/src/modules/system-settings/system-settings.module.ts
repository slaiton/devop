import { Module } from '@nestjs/common';
import { RolesGuard } from '../../common/roles.guard';
import { AuthModule } from '../auth/auth.module';
import { AuditBudgetService } from './audit-budget.service';
import { LlmProvidersService } from './llm-providers.service';
import { SystemSettingsController } from './system-settings.controller';
import { SystemSettingsService } from './system-settings.service';

@Module({
  imports: [AuthModule],
  controllers: [SystemSettingsController],
  providers: [SystemSettingsService, LlmProvidersService, AuditBudgetService, RolesGuard],
})
export class SystemSettingsModule {}
