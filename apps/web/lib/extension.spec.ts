import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayApiError } from './envelope';
import {
  createExtensionToken,
  listExtensionTokens,
  revokeExtensionToken,
  type ExtensionTokenDto,
} from './extension';

const authorizedV2RequestMock = vi.fn();

vi.mock('./api', () => ({
  authorizedV2Request: (...args: unknown[]) => authorizedV2RequestMock(...args),
}));

function makeToken(overrides: Partial<ExtensionTokenDto> = {}): ExtensionTokenDto {
  return {
    id: 'ext_tok_1',
    label: 'MacBook 公司 Chrome',
    tokenPrefix: 'gmext_AbCdEf',
    scopes: ['extension:distribution'],
    lastUsedAt: '2026-11-23T08:00:00.000Z',
    expiresAt: '2027-02-20T00:00:00.000Z',
    revokedAt: null,
    createdAt: '2026-11-22T00:00:00.000Z',
    ...overrides,
  };
}

describe('apps/web/lib/extension.ts — CN Chrome Extension token client', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls GET /extension/tokens and forwards storage & AbortSignal', async () => {
    const token = makeToken();
    authorizedV2RequestMock.mockResolvedValueOnce({ items: [token] });
    const controller = new AbortController();
    const fakeStorage = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };

    const res = await listExtensionTokens({ storage: fakeStorage, signal: controller.signal });
    expect(res.items).toEqual([token]);
    expect(authorizedV2RequestMock).toHaveBeenCalledWith('/extension/tokens', {
      method: 'GET',
      storage: fakeStorage,
      signal: controller.signal,
    });
  });

  it('calls POST /extension/tokens with label and ttlDays', async () => {
    const token = makeToken({ id: 'ext_tok_2' });
    authorizedV2RequestMock.mockResolvedValueOnce({
      token,
      plainToken: 'gmext_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd',
    });

    const res = await createExtensionToken({ label: 'MacBook 公司 Chrome', ttlDays: 90 });
    expect(res.token.id).toBe('ext_tok_2');
    expect(res.plainToken).toMatch(/^gmext_/);
    expect(authorizedV2RequestMock).toHaveBeenCalledWith('/extension/tokens', {
      method: 'POST',
      body: { label: 'MacBook 公司 Chrome', ttlDays: 90 },
      storage: undefined,
      signal: undefined,
    });
  });

  it('calls DELETE /extension/tokens/:encodedId with URL-encoded tokenId', async () => {
    authorizedV2RequestMock.mockResolvedValueOnce({
      id: 'ext/tok#1',
      revoked: true,
      revokedAt: '2026-11-24T08:00:00.000Z',
    });

    const res = await revokeExtensionToken('ext/tok#1');
    expect(res.revoked).toBe(true);
    expect(authorizedV2RequestMock).toHaveBeenCalledWith('/extension/tokens/ext%2Ftok%231', {
      method: 'DELETE',
      storage: undefined,
      signal: undefined,
    });
  });

  it('propagates GatewayApiError for 400 / 403 / 404 / 429', async () => {
    for (const [status, code, msg] of [
      [400, 40001, '请填写设备或浏览器备注名称'],
      [403, 40301, '账号已到期，当前为只读'],
      [404, 40401, '扩展配对令牌不存在'],
      [429, 42901, '操作过于频繁，请稍后再试'],
    ] as const) {
      authorizedV2RequestMock.mockRejectedValueOnce(new GatewayApiError(status, code, msg));
      await expect(createExtensionToken({ label: 'Chrome' })).rejects.toMatchObject({
        name: 'GatewayApiError',
        status,
        code,
        message: msg,
      });
    }
  });
});
