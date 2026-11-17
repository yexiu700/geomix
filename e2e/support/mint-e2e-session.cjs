'use strict';

const crypto = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

function encodeBase64Url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signJwtHs256(claims, secret) {
  const header = encodeBase64Url({ alg: 'HS256', typ: 'JWT' });
  const body = encodeBase64Url(claims);
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

async function main() {
  const username = (process.argv[2] || process.env.SEED_DEMO_USERNAME || 'demo').trim();
  const accessSecret = process.env.JWT_ACCESS_SECRET || 'change-me-access';
  const refreshSecret = process.env.JWT_REFRESH_SECRET || 'change-me-refresh';

  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({
      where: { username },
      include: { tenant: true },
    });
    if (!user) {
      throw new Error(`Seeded user "${username}" not found in database. Run pnpm db:seed first.`);
    }

    const fp = crypto.createHash('sha256').update(user.passwordHash).digest('hex').slice(0, 32);
    const lms = Date.now();
    const iat = Math.floor(lms / 1000);

    const accessToken = signJwtHs256(
      {
        sub: user.id,
        tid: user.tenantId,
        role: user.role,
        typ: 'access',
        fp,
        lms,
        iat,
        exp: iat + 3600,
      },
      accessSecret,
    );

    const refreshToken = signJwtHs256(
      {
        sub: user.id,
        tid: user.tenantId,
        role: user.role,
        typ: 'refresh',
        fp,
        lms,
        iat,
        exp: iat + 7 * 86400,
      },
      refreshSecret,
    );

    process.stdout.write(
      JSON.stringify({
        username: user.username,
        tenantId: user.tenantId,
        role: user.role,
        accessToken,
        refreshToken,
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
