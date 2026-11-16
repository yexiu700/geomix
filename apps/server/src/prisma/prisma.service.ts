import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createScopedClient } from '@geomix/db';
import { currentTenantId } from '../tenant/tenant-context';

@Injectable()
export class PrismaService implements OnModuleDestroy {
  private readonly clients = createScopedClient(() => currentTenantId());
  readonly base = this.clients.base;
  readonly scoped = this.clients.scoped;

  async onModuleDestroy(): Promise<void> {
    await this.base.$disconnect();
  }
}
