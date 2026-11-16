import { createPrismaClient } from './client';
import { applySeed } from './seed';

async function main(): Promise<void> {
  const prisma = createPrismaClient();
  try {
    const summary = await applySeed(prisma);
    console.log(JSON.stringify({ event: 'seed.done', ...summary }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'seed failed';
  console.error(message);
  process.exit(1);
});
