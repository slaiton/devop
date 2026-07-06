import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ReviewModule } from './modules/review/review.module';

@Module({
  imports: [
    BullModule.forRoot({
      connection: { url: process.env.REDIS_URL },
    }),
    ReviewModule,
  ],
})
export class AppModule {}
