import { describe, expect, it } from 'vitest';
import { clientAddress, normalizeAddress } from './client-address';

describe('clientAddress', () => {
  it('uses the socket address and ignores a spoofed forwarding header by default', () => {
    const request = {
      socket: { remoteAddress: '::ffff:203.0.113.8' },
      headers: {
        'x-real-ip': '198.51.100.20',
        'x-forwarded-for': '198.51.100.20, 203.0.113.8',
      },
    };
    expect(clientAddress(request, {})).toBe('203.0.113.8');
    expect(clientAddress(request, { AUTH_TRUST_PROXY: 'false' })).toBe('203.0.113.8');
    expect(normalizeAddress('')).toBe('unknown');
  });

  it('ignores forwarding headers from untrusted public sockets even when AUTH_TRUST_PROXY=true', () => {
    const request = {
      socket: { remoteAddress: '::ffff:203.0.113.8' },
      headers: {
        'x-real-ip': '198.51.100.99',
        'x-forwarded-for': '198.51.100.99',
      },
    };
    expect(clientAddress(request, { AUTH_TRUST_PROXY: 'true' })).toBe('203.0.113.8');
  });

  it('extracts X-Real-IP and right-to-left X-Forwarded-For behind trusted loopback or Docker private proxy', () => {
    const viaRealIp = {
      socket: { remoteAddress: '::ffff:172.18.0.1' },
      headers: {
        'x-real-ip': '198.51.100.42',
        'x-forwarded-for': '1.2.3.4, 198.51.100.42',
      },
    };
    expect(clientAddress(viaRealIp, { AUTH_TRUST_PROXY: 'true' })).toBe('198.51.100.42');

    // Client spoofed 1.2.3.4, Nginx appended actual client IP 203.0.113.77
    const viaForwardedFor = {
      socket: { remoteAddress: '127.0.0.1' },
      headers: {
        'x-forwarded-for': '1.2.3.4, 203.0.113.77, 172.18.0.2',
      },
    };
    expect(clientAddress(viaForwardedFor, { AUTH_TRUST_PROXY: 'true' })).toBe('203.0.113.77');

    // Invalid header falls back safely to remote socket IP
    const malformed = {
      socket: { remoteAddress: '127.0.0.1' },
      headers: {
        'x-real-ip': 'not-an-ip',
        'x-forwarded-for': 'garbage',
      },
    };
    expect(clientAddress(malformed, { AUTH_TRUST_PROXY: 'true' })).toBe('127.0.0.1');
  });
});
