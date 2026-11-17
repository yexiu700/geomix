import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpRewriteSingleGateway, RewriteApiError } from './rewrites';
import { saveSession, type SessionStorageLike } from './session';

function createMemoryStorage(): SessionStorageLike {
  const store = new Map<string, string>();
  const storage: SessionStorageLike = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, val) => {
      store.set(key, val);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
  saveSession(storage, 'tok_test', 'ref_test');
  return storage;
}

describe('httpRewriteSingleGateway HTML gateway error handling (#96)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('converts HTML 504 Gateway Time-out body into a clean RewriteApiError instead of SyntaxError Unexpected token <', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          '<html>\r\n<head><title>504 Gateway Time-out</title></head>\r\n<body><h1>504 Gateway Time-out</h1></body>\r\n</html>',
          {
            status: 504,
            headers: { 'content-type': 'text/html' },
          },
        );
      }),
    );

    const gw = httpRewriteSingleGateway(createMemoryStorage());
    await expect(
      gw.createSingle({
        pastedText: true,
        url: '',
        pastedTitle: '源标题',
        pastedContent: '这是一段足够长度的正文用于测试网关超时异常处理。'.repeat(12),
        mediaCategoryId: 'mcat_001',
        imageCount: 1,
        templateId: 'sys_rewrite_01',
        categoryId: null,
        autoCategoryName: '爆文复刻-测试',
        resultStatus: 'PENDING',
        brand: '',
      }),
    ).rejects.toEqual(new RewriteApiError(504, -1, '服务响应超时，请稍后重试'));
  });
});
