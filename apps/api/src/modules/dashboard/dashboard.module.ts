import { Module } from '@nestjs/common';
import { EmailService } from '../../common/email.service';
import { RolesGuard } from '../../common/roles.guard';
import { AuthModule } from '../auth/auth.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [AuthModule],
  controllers: [DashboardController],
  providers: [DashboardService, EmailService, RolesGuard],
})
export class DashboardModule {}
