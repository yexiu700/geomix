import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { BrandsModule } from '../brands/brands.module';
import { SecretBox } from '../common/secret-box';
import { AdaptersModule } from '../infra/adapters.module';
import { PrismaModule } from '../prisma/prisma.module';
import { StudioModule } from '../studio/studio.module';
import { ConnectionsController } from './connections.controller';
import { ConnectionsService } from './connections.service';
import {
  CmsConnectorRegistry,
  ShopifyConnector,
  WebflowConnector,
  WebhookConnector,
  WordPressConnector,
} from './connectors';
import { CrawlProbeService } from './crawl-probe.service';
import { DistributionController } from './distribution.controller';
import { DistributionRunner } from './distribution.runner';
import { DistributionService } from './distribution.service';
import { IndexNowService } from './indexnow.service';
import { PublicPrPacketController } from './public-pr-packet.controller';
import { PublicPrPacketService } from './public-pr-packet.service';
import { RetestSchedulerService } from './retest-scheduler.service';
import { VariantGeneratorService } from './variant-generator.service';

@Module({
  imports: [PrismaModule, AuthModule, BillingModule, AdaptersModule, BrandsModule, StudioModule],
  controllers: [ConnectionsController, DistributionController, PublicPrPacketController],
  providers: [
    SecretBox,
    ShopifyConnector,
    WordPressConnector,
    WebflowConnector,
    WebhookConnector,
    CmsConnectorRegistry,
    IndexNowService,
    ConnectionsService,
    VariantGeneratorService,
    CrawlProbeService,
    RetestSchedulerService,
    DistributionService,
    DistributionRunner,
    PublicPrPacketService,
  ],
  exports: [
    SecretBox,
    CmsConnectorRegistry,
    IndexNowService,
    ConnectionsService,
    VariantGeneratorService,
    CrawlProbeService,
    RetestSchedulerService,
    DistributionService,
    DistributionRunner,
    PublicPrPacketService,
  ],
})
export class DistributionModule {}
