import { createHash } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { parseEnv, resolveStorageSettings, type StorageSettings } from '@geomix/shared';
import { ProviderError, PROVIDER_KIND } from './provider-error';

const TENANT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const OBJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MEMORY_MAX_OBJECTS = 200;

export type StoredObject = {
  key: string;
  bytes: number;
  contentType: string;
  sha256: string;
  replayed: boolean;
};

export interface ObjectClient {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: Buffer; contentType: string } | null>;
  delete(key: string): Promise<void>;
}

type MemoryEntry = { body: Buffer; contentType: string; sha256: string };

/**
 * 对象键固定带租户前缀。幂等重放只在当前进程生效，避免同一张图被记两次；
 * 多进程去重留给后续上传流程，这里不改表。
 */
export class StorageService {
  private readonly objects = new Map<string, MemoryEntry>();
  private readonly hashes = new Map<string, string>();
  private readonly idempotency = new Map<string, StoredObject>();

  constructor(
    private readonly settings: StorageSettings,
    private readonly client: ObjectClient,
    private readonly memory: boolean,
  ) {}

  static fromEnv(env: Record<string, string | undefined>): StorageService {
    const settings = resolveStorageSettings(env);
    if (settings.driver === 'memory')
      return new StorageService(settings, new MemoryObjectClient(), true);
    return new StorageService(settings, createS3ObjectClient(env), false);
  }

  async put(input: {
    tenantId: string;
    name: string;
    body: Buffer;
    contentType: string;
    idempotencyKey: string;
  }): Promise<StoredObject> {
    const key = objectKey(input.tenantId, input.name);
    if (!CONTENT_TYPES.has(input.contentType)) {
      throw new ProviderError(PROVIDER_KIND.CONTRACT, '对象类型不受支持', 'content_type');
    }
    if (!Buffer.isBuffer(input.body) || input.body.length === 0) {
      throw new ProviderError(PROVIDER_KIND.CONTRACT, '对象内容不正确', 'empty');
    }
    if (input.body.length > this.settings.maxObjectBytes) {
      throw new ProviderError(PROVIDER_KIND.TOO_LARGE, '对象超过大小限制', 'object');
    }
    if (!/^[A-Za-z0-9:_-]{8,128}$/.test(input.idempotencyKey)) {
      throw new ProviderError(PROVIDER_KIND.CONTRACT, '幂等键不正确', 'idempotency');
    }
    const sha256 = createHash('sha256').update(input.body).digest('hex');
    const idemKey = `${input.tenantId}::${input.idempotencyKey}`;
    const previous = this.idempotency.get(idemKey);
    if (previous) {
      if (previous.sha256 !== sha256 || previous.key !== key) {
        throw new ProviderError(
          PROVIDER_KIND.CONFLICT,
          '同一个幂等键不能改存不同内容',
          'idempotency',
        );
      }
      return { ...previous, replayed: true };
    }
    const existingHash = this.hashes.get(key);
    if (existingHash && existingHash !== sha256) {
      throw new ProviderError(PROVIDER_KIND.CONFLICT, '同名对象内容不一致', 'object');
    }
    if (this.memory && !existingHash && this.objects.size >= MEMORY_MAX_OBJECTS) {
      throw new ProviderError(PROVIDER_KIND.TOO_LARGE, '内存存储已满', 'count');
    }
    if (!existingHash) {
      await this.client.put(key, input.body, input.contentType);
      this.hashes.set(key, sha256);
      if (this.memory)
        this.objects.set(key, { body: input.body, contentType: input.contentType, sha256 });
    }
    const stored: StoredObject = {
      key,
      bytes: input.body.length,
      contentType: input.contentType,
      sha256,
      replayed: false,
    };
    this.idempotency.set(idemKey, stored);
    return stored;
  }

  async get(tenantId: string, name: string): Promise<{ body: Buffer; contentType: string } | null> {
    const key = objectKey(tenantId, name);
    if (this.memory) {
      const found = this.objects.get(key);
      return found ? { body: found.body, contentType: found.contentType } : null;
    }
    return this.client.get(key);
  }

  async delete(tenantId: string, name: string): Promise<void> {
    const key = objectKey(tenantId, name);
    await this.client.delete(key);
    this.objects.delete(key);
    this.hashes.delete(key);
  }
}

class MemoryObjectClient implements ObjectClient {
  async put(): Promise<void> {
    return undefined;
  }

  async get(): Promise<null> {
    return null;
  }

  async delete(): Promise<void> {
    return undefined;
  }
}

export function createS3ObjectClient(env: Record<string, string | undefined>): ObjectClient {
  const parsed = parseEnv(env);
  const client = new S3Client({
    region: parsed.S3_REGION,
    endpoint: parsed.S3_ENDPOINT,
    forcePathStyle: parsed.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: parsed.S3_ACCESS_KEY_ID,
      secretAccessKey: parsed.S3_SECRET_ACCESS_KEY,
    },
  });
  const bucket = parsed.S3_BUCKET;
  return {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },
    async get(key) {
      try {
        const output = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!output.Body) return null;
        const bytes = Buffer.from(await output.Body.transformToByteArray());
        return { body: bytes, contentType: output.ContentType ?? 'application/octet-stream' };
      } catch (error) {
        if (isMissing(error)) return null;
        throw new ProviderError(PROVIDER_KIND.UPSTREAM, '对象存储暂时不可用', 's3');
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

function objectKey(tenantId: string, name: string): string {
  if (!TENANT_ID.test(tenantId))
    throw new ProviderError(PROVIDER_KIND.CONTRACT, '租户不正确', 'tenant');
  if (!OBJECT_NAME.test(name) || name.includes('..')) {
    throw new ProviderError(PROVIDER_KIND.CONTRACT, '对象名不正确', 'name');
  }
  return `tenants/${tenantId}/${name}`;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error.name === 'NoSuchKey' || error.name === 'NotFound')
  );
}
