import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BrandsModule } from '../brands/brands.module';
import { AdaptersModule } from '../infra/adapters.module';
import { PrismaModule } from '../prisma/prisma.module';
import { StudioModule } from '../studio/studio.module';
import { ExtensionAuthGuard } from './extension-auth.guard';
import { ExtensionBridgeController } from './extension-bridge.controller';
import { ExtensionBridgeService } from './extension-bridge.service';
import { ExtensionTokenLookupService } from './extension-token-lookup.service';
import { ExtensionTokenService } from './extension-token.service';
import { ExtensionTokensController } from './extension-tokens.controller';

@Module({
  imports: [PrismaModule, AuthModule, AdaptersModule, BrandsModule, StudioModule],
  controllers: [ExtensionTokensController, ExtensionBridgeController],
  providers: [
    ExtensionTokenLookupService,
    ExtensionAuthGuard,
    ExtensionTokenService,
    ExtensionBridgeService,
  ],
  exports: [ExtensionTokenService, ExtensionBridgeService, ExtensionTokenLookupService],
})
export class ExtensionModule {}
