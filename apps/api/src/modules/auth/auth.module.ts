import { Module } from '@nestjs/common';
import { RolesGuard } from '../../common/roles.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService, RolesGuard],
  exports: [AuthService],
})
export class AuthModule {}
