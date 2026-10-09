import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PasskeysController } from './passkeys.controller';
import { PasskeysService } from './passkeys.service';

@Module({
  imports: [AuthModule],
  controllers: [PasskeysController],
  providers: [PasskeysService],
  exports: [PasskeysService],
})
export class PasskeysModule {}
