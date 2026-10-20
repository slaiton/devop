import { Module } from '@nestjs/common';
import { RolesGuard } from '../../common/roles.guard';
import { AuthModule } from '../auth/auth.module';
import { GithubAppsController } from './github-apps.controller';
import { GithubAppsService } from './github-apps.service';
import { RepositoryReadinessController } from './repositoryReadiness.controller';
import { RepositoryReadinessService } from './repositoryReadiness.service';

@Module({
  imports: [AuthModule],
  controllers: [GithubAppsController, RepositoryReadinessController],
  providers: [GithubAppsService, RepositoryReadinessService, RolesGuard],
})
export class GithubAppsModule {}
