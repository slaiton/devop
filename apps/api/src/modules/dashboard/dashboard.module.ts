import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { RECONSIDER_QUEUE_NAME } from '@devsentinel/event-contracts';
import { EmailService } from '../../common/email.service';
import { RolesGuard } from '../../common/roles.guard';
import { AuthModule } from '../auth/auth.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [AuthModule, BullModule.registerQueue({ name: RECONSIDER_QUEUE_NAME })],
  controllers: [DashboardController],
  providers: [DashboardService, EmailService, RolesGuard],
})
export class DashboardModule {}
