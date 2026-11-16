import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DB_EMBEDDING_DIMENSIONS,
  FAKE_MARK,
  FAKE_TOKEN_COST_MICRO,
  IMAGE_MAX_OUTPUT_BYTES,
  readLlmDocument,
  resolveEmbeddingSettings,
  resolveImageSettings,
  resolveLlmRoute,
  resolveSearchSettings,
  resolveStorageSettings,
} from './adapters';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('adapter config', () => {
  it('keeps the embedding width on the database vector size', () => {
    expect(DB_EMBEDDING_DIMENSIONS).toBe(1024);
    expect(FAKE_MARK).toBe('【FAKE】');
    expect(FAKE_TOKEN_COST_MICRO).toBe(1);
    expect(IMAGE_MAX_OUTPUT_BYTES).toBe(1024 * 1024);
    expect(resolveEmbeddingSettings({}).dimensions).toBe(1024);
    expect(resolveEmbeddingSettings({}).provider).toBe('fake');
  });

  it('rejects an embedding width that would not fit vector(1024)', () => {
    expect(() => resolveEmbeddingSettings({ EMBEDDING_DIMENSIONS: '768' })).toThrow(/1024/);
    expect(() => resolveEmbeddingSettings({ EMBEDDING_PROVIDER: 'vendor' })).toThrow(
      /fake or openai/,
    );
  });

  it('routes an empty provider document to the fake provider', () => {
    const route = resolveLlmRoute({});
    expect(route.providers.fake).toEqual({ kind: 'fake' });
    expect(route.route.body).toEqual({ primary: 'fake', backup: [] });
    expect(route.route.rewrite.primary).toBe('fake');
    expect(route.route.distill.primary).toBe('fake');
    expect(readLlmDocument({})).toEqual(route);
  });

  it('uses DeepSeek for configured scenes and keeps Tongyi then Doubao as backup', () => {
    const route = resolveLlmRoute({
      providers: {
        deepseek: {
          kind: 'openai',
          baseUrl: 'https://llm.example/v1',
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          cheapModel: 'cheap-placeholder',
          qualityModel: 'quality-placeholder',
        },
        tongyi: {
          kind: 'openai',
          baseUrl: 'https://backup.example/v1',
          apiKeyEnv: 'TONGYI_API_KEY',
          cheapModel: 'cheap-placeholder',
          qualityModel: 'quality-placeholder',
        },
        doubao: {
          kind: 'openai',
          baseUrl: 'https://second.example/v1',
          apiKeyEnv: 'DOUBAO_API_KEY',
          cheapModel: 'cheap-placeholder',
          qualityModel: 'quality-placeholder',
        },
      },
    });
    expect(route.route.body).toEqual({ primary: 'deepseek', backup: ['tongyi', 'doubao'] });
    expect(route.route.rewrite).toEqual(route.route.body);
    expect(route.route.title.primary).toBe('deepseek');
  });

  it('rejects provider URLs that embed credentials or skip https', () => {
    expect(() =>
      resolveLlmRoute({
        providers: {
          deepseek: {
            kind: 'openai',
            baseUrl: 'http://llm.example/v1',
            apiKeyEnv: 'DEEPSEEK_API_KEY',
            cheapModel: 'm',
            qualityModel: 'm',
          },
        },
      }),
    ).toThrow(/https/);
    expect(() =>
      resolveLlmRoute({
        providers: {
          deepseek: {
            kind: 'openai',
            baseUrl: 'https://user:secret@llm.example/v1',
            apiKeyEnv: 'DEEPSEEK_API_KEY',
            cheapModel: 'm',
            qualityModel: 'm',
          },
        },
      }),
    ).toThrow(/credentials/);
    expect(() => resolveLlmRoute({ providers: {} })).toThrow(/at least one/);
    expect(() =>
      resolveLlmRoute({
        providers: { fake: { kind: 'fake' } },
        route: { body: { primary: 'missing', backup: [] } },
      }),
    ).toThrow(/unknown provider/);
  });

  it('keeps search on the link list and storage in memory unless configured', () => {
    expect(resolveSearchSettings({}).provider).toBe('link_list');
    expect(resolveSearchSettings({}).endpoint).toBeNull();
    expect(() => resolveSearchSettings({ SEARCH_PROVIDER: 'bocha' })).toThrow(
      /link_list or remote/,
    );
    expect(resolveImageSettings({}).provider).toBe('fake');
    expect(resolveStorageSettings({}).driver).toBe('memory');
  });

  it('documents empty key names in the example env and no live secrets', () => {
    const text = readFileSync(resolve(repoRoot, '.env.example'), 'utf8');
    for (const key of [
      'DEEPSEEK_API_KEY=',
      'TONGYI_API_KEY=',
      'DOUBAO_API_KEY=',
      'EMBEDDING_API_KEY=',
      'IMAGE_API_KEY=',
      'SEARCH_REMOTE_API_KEY=',
      'EMBEDDING_DIMENSIONS=1024',
      'SEARCH_PROVIDER=link_list',
      'STORAGE_DRIVER=memory',
    ]) {
      expect(text).toContain(key);
    }
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
  });
});
