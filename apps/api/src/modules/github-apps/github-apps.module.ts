import { Module } from '@nestjs/common';
import { RolesGuard } from '../../common/roles.guard';
import { AuthModule } from '../auth/auth.module';
import { GithubAppsController } from './github-apps.controller';
import { GithubAppsService } from './github-apps.service';

@Module({
  imports: [AuthModule],
  controllers: [GithubAppsController],
  providers: [GithubAppsService, RolesGuard],
})
export class GithubAppsModule {}
