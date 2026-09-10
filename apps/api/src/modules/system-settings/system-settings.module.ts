import { Module } from '@nestjs/common';
import { RolesGuard } from '../../common/roles.guard';
import { AuthModule } from '../auth/auth.module';
import { SystemSettingsController } from './system-settings.controller';
import { SystemSettingsService } from './system-settings.service';

@Module({
  imports: [AuthModule],
  controllers: [SystemSettingsController],
  providers: [SystemSettingsService, RolesGuard],
})
export class SystemSettingsModule {}
