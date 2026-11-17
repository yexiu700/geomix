import { buildSeedWrites, readSeedConfig } from '@geomix/db';
import { PromptKind } from '@prisma/client';
import { TX_OPTIONS } from '../billing/billing.sql';
import type { PrismaService } from '../prisma/prisma.service';

export async function ensureBuiltInSystemTemplates(prisma: PrismaService): Promise<void> {
  const existingCount = await prisma.base.promptTemplate.count({
    where: { tenantId: null },
  });
  if (existingCount >= 18) {
    return;
  }
  const seed = buildSeedWrites({ config: readSeedConfig(), now: new Date() });
  await prisma.base.$transaction(async (tx) => {
    for (const tpl of seed.templates) {
      await tx.promptTemplate.upsert({
        where: { id: tpl.id },
        create: {
          id: tpl.id,
          tenantId: null,
          kind: PromptKind[tpl.kind],
          name: tpl.name,
          content: tpl.content,
          randomPool: tpl.randomPool,
          sort: tpl.sort,
        },
        update: {},
      });
    }
  }, TX_OPTIONS);
}
