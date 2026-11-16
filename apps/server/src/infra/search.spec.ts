import { describe, expect, it } from 'vitest';
import type { HttpTransport } from './guarded-request';
import { SearchService } from './search';

describe('search provider', () => {
  it('uses the pasted link list and does not request any of the links', async () => {
    let calls = 0;
    const transport: HttpTransport = async () => {
      calls += 1;
      throw new Error('link_list must not fetch');
    };
    const service = SearchService.fromEnv({ SEARCH_PROVIDER: 'link_list' }, { transport });
    const result = await service.search({
      keyword: '占位主题',
      limit: 5,
      links: [
        'https://public.example/a?utm_source=x&b=1',
        'https://public.example/a?b=1&utm_source=y',
        'http://10.1.2.3/hidden',
        'http://[fe80::1]/hidden',
        'https://public.example:8443/nope',
        '',
        'https://docs.example/page',
      ].join('\n'),
    });
    expect(calls).toBe(0);
    expect(result.provider).toBe('link_list');
    expect(result.hits.map((hit) => hit.url)).toEqual([
      'https://public.example/a?b=1',
      'https://docs.example/page',
    ]);
    expect(
      result.hits.every(
        (hit) => hit.title === '' && hit.snippet === '' && hit.useSnippetAsBody === false,
      ),
    ).toBe(true);
    expect(result.rejected.map((item) => item.reason)).toEqual(['url', 'url', 'url']);
  });

  it('does not call a remote search without a key, and keeps snippets out of the body role', async () => {
    let calls = 0;
    const transport: HttpTransport = async (request) => {
      calls += 1;
      expect(request.headers.authorization).toBe('Bearer test-key');
      return {
        status: 200,
        headers: {},
        body: Buffer.from(
          JSON.stringify({
            results: [
              { url: 'https://public.example/item', title: '标题', snippet: '这只是摘要' },
              { url: 'http://127.0.0.1/secret', title: 'no', snippet: 'no' },
            ],
          }),
        ),
      };
    };
    const missing = SearchService.fromEnv(
      { SEARCH_PROVIDER: 'remote', SEARCH_REMOTE_ENDPOINT: 'https://192.0.2.10/search' },
      {
        transport,
        resolver: {
          async resolve() {
            return [{ address: '192.0.2.10', family: 4 }];
          },
        },
      },
    );
    await expect(missing.search({ keyword: '占位', limit: 3 })).rejects.toMatchObject({
      kind: 'auth',
    });
    expect(calls).toBe(0);

    const keyed = SearchService.fromEnv(
      {
        SEARCH_PROVIDER: 'remote',
        SEARCH_REMOTE_ENDPOINT: 'https://192.0.2.10/search',
        SEARCH_REMOTE_API_KEY: 'test-key',
      },
      {
        transport,
        resolver: {
          async resolve() {
            return [{ address: '192.0.2.10', family: 4 }];
          },
        },
      },
    );
    const result = await keyed.search({ keyword: '占位', limit: 3 });
    expect(result.hits).toEqual([
      {
        url: 'https://public.example/item',
        title: '标题',
        snippet: '这只是摘要',
        useSnippetAsBody: false,
      },
    ]);
    expect(result.rejected).toEqual([{ line: 2, reason: 'url' }]);
    expect(calls).toBe(1);
  });
});
