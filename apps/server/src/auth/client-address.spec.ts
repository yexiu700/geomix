import { describe, expect, it } from 'vitest';
import { clientAddress, normalizeAddress } from './client-address';

describe('clientAddress', () => {
  it('uses the socket address and ignores a spoofed forwarding header', () => {
    const request = {
      socket: { remoteAddress: '::ffff:203.0.113.8' },
      headers: { 'x-forwarded-for': '198.51.100.20, 203.0.113.8' },
    };
    expect(clientAddress(request)).toBe('203.0.113.8');
    expect(normalizeAddress('')).toBe('unknown');
  });
});
