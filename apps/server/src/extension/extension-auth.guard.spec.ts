import type { ExecutionContext } from '@nestjs/common';
import { API_ERROR, AUTH_ERROR } from '@geomix/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../common/api-error';
import type { PrismaService } from '../prisma/prisma.service';
import { currentTenantId } from '../tenant/tenant-context';
import { ExtensionAuthGuard } from './extension-auth.guard';
import { getExtensionAuth, type ExtensionHttpRequest } from './extension-auth.types';
import { formatMaskedUserDisplayName } from './extension-bridge.service';
import {
  appendVaryOrigin,
  createExtensionBridgeCorsMiddleware,
  isAllowedChromeExtensionOrigin,
  isExtensionBridgeCorsPath,
  readSingleOriginHeader,
  type CorsRequestLike,
  type CorsResponseLike,
} from './extension-cors';
import { ExtensionTokenLookupService, hashExtensionToken } from './extension-token-lookup.service';

const VALID_TOKEN = `gmext_${'A'.repeat(43)}`;
const VALID_TOKEN_HASH = hashExtensionToken(VALID_TOKEN);
const FUTURE = new Date(Date.now() + 30 * 86_400_000);
const PAST = new Date(Date.now() - 60_000);

function makeRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ext_tok_1',
    tenantId: 'tenant_a',
    userId: 'user_a',
    label: 'MacBook Chrome',
    tokenPrefix: VALID_TOKEN.slice(0, 12),
    scopes: ['extension:distribution'],
    expiresAt: FUTURE,
    revokedAt: null,
    tenant: {
      name: '租户A',
      isActive: true,
      expiresAt: FUTURE,
    },
    ...overrides,
  };
}

function makeContext(request: ExtensionHttpRequest & { auth?: unknown; authFailure?: unknown }) {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

async function expectApiError(
  promise: Promise<unknown>,
  expectedStatus: number,
  expectedCode: number,
): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(expectedStatus);
    expect(apiErr.code).toBe(expectedCode);
    return apiErr;
  }
  throw new Error(`Expected ApiError(${expectedStatus}, ${expectedCode}) but promise resolved`);
}

describe('ExtensionAuthGuard & ExtensionTokenLookupService', () => {
  function setup(record: unknown = makeRecord(), updateImpl?: () => Promise<unknown>) {
    const observedTenants: Array<string | undefined> = [];
    const findUnique = vi.fn(async () => record);
    const updateMany = vi.fn(async () => {
      observedTenants.push(currentTenantId());
      if (updateImpl) {
        return updateImpl();
      }
      return { count: 1 };
    });

    const prisma = {
      base: {
        extensionAccessToken: {
          findUnique,
        },
      },
      scoped: {
        extensionAccessToken: {
          updateMany,
        },
      },
    } as unknown as PrismaService;

    const lookup = new ExtensionTokenLookupService(prisma);
    const guard = new ExtensionAuthGuard(lookup);
    return { guard, lookup, findUnique, updateMany, observedTenants };
  }

  it('rejects missing, empty, array, and non-Bearer Authorization headers before DB lookup', async () => {
    const { guard, findUnique } = setup();

    await expectApiError(
      guard.canActivate(makeContext({ headers: {} })),
      401,
      AUTH_ERROR.UNAUTHORIZED,
    );
    await expectApiError(
      guard.canActivate(makeContext({ headers: { authorization: '   ' } })),
      401,
      AUTH_ERROR.UNAUTHORIZED,
    );
    await expectApiError(
      guard.canActivate(makeContext({ headers: { authorization: [`Bearer ${VALID_TOKEN}`] } })),
      401,
      AUTH_ERROR.UNAUTHORIZED,
    );
    await expectApiError(
      guard.canActivate(makeContext({ headers: { authorization: `Basic ${VALID_TOKEN}` } })),
      401,
      AUTH_ERROR.UNAUTHORIZED,
    );
    await expectApiError(
      guard.canActivate(makeContext({ headers: { authorization: `Token ${VALID_TOKEN}` } })),
      401,
      AUTH_ERROR.UNAUTHORIZED,
    );
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('enforces RFC 6750 single ASCII space Bearer header and rejects double-space, HTAB, surrounding whitespace, and CRLF before DB lookup', async () => {
    const { guard, findUnique } = setup();
    const malformedHeaders = [
      `Bearer  ${VALID_TOKEN}`,
      `Bearer\t${VALID_TOKEN}`,
      ` Bearer ${VALID_TOKEN}`,
      `Bearer ${VALID_TOKEN} `,
      `Bearer ${VALID_TOKEN}\r\n`,
      `Bearer ${VALID_TOKEN}\n`,
    ];

    for (const authorization of malformedHeaders) {
      await expectApiError(
        guard.canActivate(makeContext({ headers: { authorization } })),
        401,
        AUTH_ERROR.UNAUTHORIZED,
      );
    }
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('rejects console JWTs, wrong prefixes, and malformed gmext_ tokens before hitting prisma.base', async () => {
    const { guard, findUnique } = setup();
    const invalidTokens = [
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1MSJ9.sig',
      `gmx_${'a'.repeat(43)}`,
      `sk_${'a'.repeat(43)}`,
      'gmext_short',
      `gmext_${'a'.repeat(31)}`,
      `gmext_${'a'.repeat(129)}`,
      `gmext_${'a'.repeat(20)}.${'b'.repeat(20)}`,
      `gmext_${'a'.repeat(20)}!${'b'.repeat(20)}`,
    ];

    for (const token of invalidTokens) {
      await expectApiError(
        guard.canActivate(makeContext({ headers: { authorization: `Bearer ${token}` } })),
        401,
        AUTH_ERROR.UNAUTHORIZED,
      );
    }
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('rejects unknown, revoked, expired, and missing-scope tokens with 401 / 40101', async () => {
    const unknown = setup(null);
    await expectApiError(
      unknown.guard.canActivate(
        makeContext({ headers: { authorization: `Bearer ${VALID_TOKEN}` } }),
      ),
      401,
      AUTH_ERROR.UNAUTHORIZED,
    );
    expect(unknown.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: VALID_TOKEN_HASH } }),
    );

    const revoked = setup(makeRecord({ revokedAt: PAST }));
    await expectApiError(
      revoked.guard.canActivate(
        makeContext({ headers: { authorization: `Bearer ${VALID_TOKEN}` } }),
      ),
      401,
      AUTH_ERROR.UNAUTHORIZED,
    );

    const expired = setup(makeRecord({ expiresAt: PAST }));
    await expectApiError(
      expired.guard.canActivate(
        makeContext({ headers: { authorization: `Bearer ${VALID_TOKEN}` } }),
      ),
      401,
      AUTH_ERROR.UNAUTHORIZED,
    );

    const noScope = setup(makeRecord({ scopes: [] }));
    await expectApiError(
      noScope.guard.canActivate(
        makeContext({ headers: { authorization: `Bearer ${VALID_TOKEN}` } }),
      ),
      401,
      AUTH_ERROR.UNAUTHORIZED,
    );

    const wrongScope = setup(makeRecord({ scopes: ['other:scope'] }));
    await expectApiError(
      wrongScope.guard.canActivate(
        makeContext({ headers: { authorization: `Bearer ${VALID_TOKEN}` } }),
      ),
      401,
      AUTH_ERROR.UNAUTHORIZED,
    );
  });

  it('rejects inactive and expired tenants with 403 / 40301', async () => {
    const inactive = setup(
      makeRecord({
        tenant: { name: '停用租户', isActive: false, expiresAt: FUTURE },
      }),
    );
    await expectApiError(
      inactive.guard.canActivate(
        makeContext({ headers: { authorization: `Bearer ${VALID_TOKEN}` } }),
      ),
      403,
      API_ERROR.TENANT_EXPIRED,
    );

    const expiredTenant = setup(
      makeRecord({
        tenant: { name: '过期租户', isActive: true, expiresAt: PAST },
      }),
    );
    await expectApiError(
      expiredTenant.guard.canActivate(
        makeContext({ headers: { authorization: `Bearer ${VALID_TOKEN}` } }),
      ),
      403,
      API_ERROR.TENANT_EXPIRED,
    );
  });

  it('attaches isolated req.extensionAuth (ignoring req.authFailure, never setting req.auth) and updates lastUsedAt inside runInTenant', async () => {
    const { guard, updateMany, observedTenants } = setup();
    const request: ExtensionHttpRequest & { auth?: unknown; authFailure?: unknown } = {
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
      authFailure: { status: 401, code: AUTH_ERROR.UNAUTHORIZED, msg: '未登录' },
    };

    const allowed = await guard.canActivate(makeContext(request));
    expect(allowed).toBe(true);
    expect(request.auth).toBeUndefined();
    expect(getExtensionAuth(request)).toMatchObject({
      tokenId: 'ext_tok_1',
      tenantId: 'tenant_a',
      userId: 'user_a',
      tokenLabel: 'MacBook Chrome',
      tokenPrefix: VALID_TOKEN.slice(0, 12),
      scopes: ['extension:distribution'],
    });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(observedTenants).toEqual(['tenant_a']);
    // ALS context must not leak outside runInTenant
    expect(currentTenantId()).toBeUndefined();
  });

  it('succeeds cleanly when lastUsedAt DB update fails transiently', async () => {
    const { guard, updateMany } = setup(makeRecord(), async () => {
      throw new Error('DB transient timeout');
    });
    const request: ExtensionHttpRequest = {
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    };

    const allowed = await guard.canActivate(makeContext(request));
    expect(allowed).toBe(true);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(getExtensionAuth(request).tenantId).toBe('tenant_a');
  });
});

describe('extension-cors pure helpers & middleware', () => {
  const VALID_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

  it('enforces exact 32 lowercase [a-p] Chrome extension origins', () => {
    expect(isAllowedChromeExtensionOrigin(VALID_ORIGIN)).toBe(true);
    expect(
      isAllowedChromeExtensionOrigin('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    ).toBe(true);

    const rejected = [
      '',
      '*',
      'null',
      'https://evil.example.com',
      'chrome-extension://*',
      'chrome-extension://evil',
      'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', // 31
      'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', // 33
      'chrome-extension://AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // uppercase
      'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaq', // 'q' outside a-p
      'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', // digit
      `${VALID_ORIGIN}/`,
      `${VALID_ORIGIN}/popup.html`,
      `${VALID_ORIGIN}:8080`,
      ` ${VALID_ORIGIN}`,
      `${VALID_ORIGIN} `,
    ];
    for (const origin of rejected) {
      expect(isAllowedChromeExtensionOrigin(origin), origin).toBe(false);
    }
  });

  it('matches only the 3 exact bridge routes and rejects traversal & non-bridge paths', () => {
    const allowedPaths = [
      '/api/v2/extension/me',
      '/api/v2/extension/me/',
      '/api/v2/extension/me?foo=1',
      '/api/v2/extension/tasks',
      '/api/v2/extension/tasks?brandId=b1&provider=ZHIHU_EXT',
      '/api/v2/extension/tasks/cm123_abc-9/confirm-published',
      '/api/v2/extension/tasks/task_1/confirm-published/',
    ];
    for (const path of allowedPaths) {
      expect(isExtensionBridgeCorsPath(path), path).toBe(true);
    }

    const rejectedPaths = [
      '/api/v2/extension/tokens',
      '/api/v2/extension/tokens/tok_1',
      '/api/v2/brands',
      '/api/v1/billing/wallet',
      '/api/v1/admin/tenants',
      '/api/v2/extension/me/extra',
      '/api/v2/extension/me//',
      '/api/v2/extension/tasks//confirm-published',
      '/api/v2/extension/tasks/../tokens',
      '/api/v2/extension/tasks/%2e%2e/tokens',
      '/api/v2/extension/tasks/..%2ftokens',
      '/api/v2/extension/tasks/foo/../../brands/confirm-published',
      '/api/v2/extension/tasks/a\\b/confirm-published',
      '/api/v2/extension/tasks/t1/other',
      '/api/v2/extension/me#frag',
      '/api/v2/extension/me#/../tokens',
    ];
    for (const path of rejectedPaths) {
      expect(isExtensionBridgeCorsPath(path), path).toBe(false);
    }
  });

  it('reads single Origin header strictly and deduplicates Vary: Origin', () => {
    expect(readSingleOriginHeader({ headers: { origin: VALID_ORIGIN } })).toBe(VALID_ORIGIN);
    expect(readSingleOriginHeader({ headers: {} })).toBeNull();
    expect(readSingleOriginHeader({ headers: { origin: '' } })).toBeNull();
    expect(
      readSingleOriginHeader({ headers: { origin: [VALID_ORIGIN, 'https://a.com'] } }),
    ).toBeNull();

    const headers = new Map<string, string | string[]>();
    const res: CorsResponseLike = {
      statusCode: 200,
      getHeader: (name) => headers.get(name.toLowerCase()),
      setHeader: (name, value) => headers.set(name.toLowerCase(), value),
      end: vi.fn(),
    };
    headers.set('vary', 'Accept-Encoding');
    appendVaryOrigin(res);
    expect(headers.get('vary')).toBe('Accept-Encoding, Origin');
    appendVaryOrigin(res);
    expect(headers.get('vary')).toBe('Accept-Encoding, Origin');
  });

  it('middleware rejects disallowed OPTIONS preflight with 403 and zero Access-Control-* headers', () => {
    const mw = createExtensionBridgeCorsMiddleware(new Set(['http://localhost:3000']));
    const headers = new Map<string, string | string[]>();
    const end = vi.fn();
    const next = vi.fn();
    const req: CorsRequestLike = {
      method: 'OPTIONS',
      originalUrl: '/api/v2/extension/tokens',
      headers: { origin: VALID_ORIGIN },
    };
    const res: CorsResponseLike = {
      statusCode: 200,
      getHeader: (name) => headers.get(name.toLowerCase()),
      setHeader: (name, value) => headers.set(name.toLowerCase(), value),
      end,
    };

    mw(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(end).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    expect(headers.get('vary')).toBe('Origin');
    for (const key of headers.keys()) {
      expect(key.startsWith('access-control-')).toBe(false);
    }
  });

  it('middleware rejects duplicate array Origin headers with 403 on OPTIONS, Vary: Origin, and zero Access-Control-* headers', () => {
    const mw = createExtensionBridgeCorsMiddleware(new Set(['http://localhost:3000']));

    // OPTIONS preflight with array Origin -> 403 + Content-Length: 0 + Vary: Origin
    const optHeaders = new Map<string, string | string[]>();
    const optEnd = vi.fn();
    const optNext = vi.fn();
    const optRes: CorsResponseLike = {
      statusCode: 200,
      getHeader: (name) => optHeaders.get(name.toLowerCase()),
      setHeader: (name, value) => optHeaders.set(name.toLowerCase(), value),
      end: optEnd,
    };
    mw(
      {
        method: 'OPTIONS',
        originalUrl: '/api/v2/extension/me',
        headers: { origin: [VALID_ORIGIN, 'https://evil.example'] },
      },
      optRes,
      optNext,
    );
    expect(optRes.statusCode).toBe(403);
    expect(optHeaders.get('content-length')).toBe('0');
    expect(optHeaders.get('vary')).toBe('Origin');
    expect(optEnd).toHaveBeenCalledTimes(1);
    expect(optNext).not.toHaveBeenCalled();
    for (const key of optHeaders.keys()) {
      expect(key.startsWith('access-control-')).toBe(false);
    }

    // Non-OPTIONS with array Origin -> next() + Vary: Origin + zero Access-Control-*
    const getHeaders = new Map<string, string | string[]>();
    const getEnd = vi.fn();
    const getNext = vi.fn();
    const getRes: CorsResponseLike = {
      statusCode: 200,
      getHeader: (name) => getHeaders.get(name.toLowerCase()),
      setHeader: (name, value) => getHeaders.set(name.toLowerCase(), value),
      end: getEnd,
    };
    mw(
      {
        method: 'GET',
        originalUrl: '/api/v2/extension/me',
        headers: { origin: [VALID_ORIGIN, 'https://evil.example'] },
      },
      getRes,
      getNext,
    );
    expect(getHeaders.get('vary')).toBe('Origin');
    expect(getNext).toHaveBeenCalledTimes(1);
    expect(getEnd).not.toHaveBeenCalled();
    for (const key of getHeaders.keys()) {
      expect(key.startsWith('access-control-')).toBe(false);
    }

    // Valid OPTIONS 204 omits Content-Length per RFC 9110 §8.6
    const okHeaders = new Map<string, string | string[]>();
    const okEnd = vi.fn();
    const okNext = vi.fn();
    const okRes: CorsResponseLike = {
      statusCode: 200,
      getHeader: (name) => okHeaders.get(name.toLowerCase()),
      setHeader: (name, value) => okHeaders.set(name.toLowerCase(), value),
      end: okEnd,
    };
    mw(
      {
        method: 'OPTIONS',
        originalUrl: '/api/v2/extension/me',
        headers: { origin: VALID_ORIGIN },
      },
      okRes,
      okNext,
    );
    expect(okRes.statusCode).toBe(204);
    expect(okHeaders.get('content-length')).toBeUndefined();
    expect(okHeaders.get('access-control-allow-origin')).toBe(VALID_ORIGIN);
    expect(okEnd).toHaveBeenCalledTimes(1);
    expect(okNext).not.toHaveBeenCalled();
  });
});

describe('formatMaskedUserDisplayName', () => {
  it('preserves normal nicknames, masks email/phone PII, masks username fallback, and falls back to tenantName', () => {
    expect(formatMaskedUserDisplayName('林小美', 'alice', '租户甲')).toBe('林小美');
    expect(formatMaskedUserDisplayName('alice@example.com', 'alice', '租户甲')).toBe(
      'al***e@example.com',
    );
    expect(formatMaskedUserDisplayName('ab@example.com', 'alice', '租户甲')).toBe(
      'a***@example.com',
    );
    expect(formatMaskedUserDisplayName('13812345678', 'alice', '租户甲')).toBe('138****5678');

    // nickname absent -> always mask username (never verbatim)
    expect(formatMaskedUserDisplayName(null, 'alice', '租户甲')).toBe('al***e');
    expect(formatMaskedUserDisplayName('   ', 'john', '租户甲')).toBe('j***n');
    expect(formatMaskedUserDisplayName(null, 'bob', '租户甲')).toBe('b***b');
    expect(formatMaskedUserDisplayName(null, 'jo', '租户甲')).toBe('j***');
    expect(formatMaskedUserDisplayName(null, 'a', '租户甲')).toBe('a***');
    expect(formatMaskedUserDisplayName(null, 'ops@geomix.ai', '租户甲')).toBe('op***s@geomix.ai');
    expect(formatMaskedUserDisplayName(null, '13987654321', '租户甲')).toBe('139****4321');

    // fallback chain
    expect(formatMaskedUserDisplayName(null, null, '  租户甲  ')).toBe('租户甲');
    expect(formatMaskedUserDisplayName('', '  ', '   ')).toBe('GeoMix 用户');
  });
});
