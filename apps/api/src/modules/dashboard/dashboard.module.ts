import { Module } from '@nestjs/common';
import { EmailService } from '../../common/email.service';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  controllers: [DashboardController],
  providers: [DashboardService, EmailService],
})
export class DashboardModule {}
