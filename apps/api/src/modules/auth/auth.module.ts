import { Module } from '@nestjs/common';
import { EmailService } from '../../common/email.service';
import { RolesGuard } from '../../common/roles.guard';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SecurityEventsService } from './securityEvents.service';

@Module({
  controllers: [AuthController, AccountController],
  providers: [AuthService, AccountService, SecurityEventsService, EmailService, RolesGuard],
  exports: [AuthService, AccountService, SecurityEventsService],
})
export class AuthModule {}
