import { Module } from '@nestjs/common';
import { GithubAppsController } from './github-apps.controller';
import { GithubAppsService } from './github-apps.service';

@Module({
  controllers: [GithubAppsController],
  providers: [GithubAppsService],
})
export class GithubAppsModule {}
