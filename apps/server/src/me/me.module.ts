import { Module } from '@nestjs/common';
import { AdaptersModule } from '../infra/adapters.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AnnouncementFeedController, MeController } from './me.controller';
import { MeService } from './me.service';

@Module({
  imports: [PrismaModule, AdaptersModule],
  controllers: [MeController, AnnouncementFeedController],
  providers: [MeService],
  exports: [MeService],
})
export class MeModule {}
