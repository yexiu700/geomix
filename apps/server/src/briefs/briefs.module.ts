import { Inject, Module, OnModuleInit } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BrandsModule } from '../brands/brands.module';
import { AdaptersModule } from '../infra/adapters.module';
import { PrismaModule } from '../prisma/prisma.module';
import { VisibilityModule } from '../visibility/visibility.module';
import { VisibilityRunRunner } from '../visibility/visibility-run.runner';
import { BriefsAutoGeneratorService } from './briefs-auto-generator.service';
import { BrandBriefsController, BriefsController } from './briefs.controller';
import { BriefsService } from './briefs.service';

@Module({
  imports: [PrismaModule, AuthModule, AdaptersModule, BrandsModule, VisibilityModule],
  controllers: [BrandBriefsController, BriefsController],
  providers: [BriefsAutoGeneratorService, BriefsService],
  exports: [BriefsService, BriefsAutoGeneratorService],
})
export class BriefsModule implements OnModuleInit {
  constructor(
    @Inject(VisibilityRunRunner) private readonly visibilityRunner: VisibilityRunRunner,
    @Inject(BriefsAutoGeneratorService) private readonly autoGenerator: BriefsAutoGeneratorService,
  ) {}

  onModuleInit(): void {
    this.visibilityRunner.registerCompleteHook(this.autoGenerator);
  }
}
