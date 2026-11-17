import { Module } from '@nestjs/common';
import { ArticlesController, CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';

@Module({
  controllers: [CategoriesController, ArticlesController],
  providers: [CategoriesService],
})
export class WritingModule {}
