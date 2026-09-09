import { Module } from '@nestjs/common';
import { RolesGuard } from '../../common/roles.guard';
import { AuthModule } from '../auth/auth.module';
import { PullRequestsController } from './pull-requests.controller';
import { PullRequestsService } from './pull-requests.service';

@Module({
  imports: [AuthModule],
  controllers: [PullRequestsController],
  providers: [PullRequestsService, RolesGuard],
})
export class PullRequestsModule {}
