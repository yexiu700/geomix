'use client';

import type {
  CreateExtensionTokenInput,
  CreateExtensionTokenResponseDto,
  ExtensionTokenDto,
} from '@geomix/shared';
import { authorizedV2Request } from './api';
import type { SessionStorageLike } from './session';

export type { CreateExtensionTokenInput, CreateExtensionTokenResponseDto, ExtensionTokenDto };

export type ExtensionClientOptions = {
  storage?: SessionStorageLike;
  signal?: AbortSignal;
};

export type ExtensionTokenListResponse = {
  items: ExtensionTokenDto[];
};

export type RevokeExtensionTokenResponse = {
  id: string;
  revoked: true;
  revokedAt: string;
};

export function listExtensionTokens(
  options?: ExtensionClientOptions,
): Promise<ExtensionTokenListResponse> {
  return authorizedV2Request<ExtensionTokenListResponse>('/extension/tokens', {
    method: 'GET',
    storage: options?.storage,
    signal: options?.signal,
  });
}

export function createExtensionToken(
  input: CreateExtensionTokenInput,
  options?: ExtensionClientOptions,
): Promise<CreateExtensionTokenResponseDto> {
  return authorizedV2Request<CreateExtensionTokenResponseDto>('/extension/tokens', {
    method: 'POST',
    body: input,
    storage: options?.storage,
    signal: options?.signal,
  });
}

export function revokeExtensionToken(
  tokenId: string,
  options?: ExtensionClientOptions,
): Promise<RevokeExtensionTokenResponse> {
  return authorizedV2Request<RevokeExtensionTokenResponse>(
    `/extension/tokens/${encodeURIComponent(tokenId)}`,
    {
      method: 'DELETE',
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}
