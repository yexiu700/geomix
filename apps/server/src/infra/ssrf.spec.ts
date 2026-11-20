import { describe, expect, it } from 'vitest';
import {
  UrlPolicyError,
  assertPublicUrl,
  ipBlockReason,
  parseIPv4Literal,
  parseSsrfAllowlist,
} from './ssrf';

describe('ip literals', () => {
  it('folds obfuscated IPv4 forms back to the real address', () => {
    expect(parseIPv4Literal('2130706433')).toBe('127.0.0.1');
    expect(parseIPv4Literal('0x7f000001')).toBe('127.0.0.1');
    expect(parseIPv4Literal('0177.0.0.1')).toBe('127.0.0.1');
    expect(parseIPv4Literal('127.1')).toBe('127.0.0.1');
    expect(parseIPv4Literal('10.1.2.3')).toBe('10.1.2.3');
    expect(parseIPv4Literal('public.example')).toBeNull();
  });

  it('blocks private, loopback, link-local, cgnat, metadata, and reserved ranges', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '169.254.1.1',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fc00::1',
      'fd00:ec2::254',
      'fe80::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '::ffff:7f00:1',
      '2002:7f00:1::',
      '2002:a00:1::',
      '64:ff9b::10.0.0.1',
      '64:ff9b::7f00:1',
    ]) {
      expect(ipBlockReason(address), address).not.toBeNull();
    }
  });

  it('allows documentation addresses used as public stand-ins', () => {
    expect(ipBlockReason('192.0.2.10')).toBeNull();
    expect(ipBlockReason('172.15.255.255')).toBeNull();
    expect(ipBlockReason('172.32.0.1')).toBeNull();
    expect(ipBlockReason('8.8.8.8')).toBeNull();
    expect(ipBlockReason('2001:db8::10')).toBeNull();
    expect(ipBlockReason('::ffff:192.0.2.10')).toBeNull();
    expect(ipBlockReason('2002:c000:20a::')).toBeNull();
  });
});

describe('url policy', () => {
  it('rejects non-public targets before any connection', () => {
    for (const raw of [
      'http://127.0.0.1/a',
      'http://127.0.0.1:8080/a',
      'http://10.1.2.3/',
      'http://192.168.0.5/',
      'http://169.254.169.254/latest',
      'http://[::1]/',
      'http://[fe80::1]/',
      'http://[fc00::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://2130706433/',
      'http://0177.0.0.1/',
      'http://localhost/',
      'http://metadata.google.internal/',
      'http://printer.local/',
      'http://192.0.2.10:8443/',
      'http://user:pass@192.0.2.10/',
      'file:///etc/passwd',
    ]) {
      expect(() => assertPublicUrl(raw), raw).toThrow(UrlPolicyError);
    }
  });

  it('accepts http and https on ports 80 and 443', () => {
    expect(assertPublicUrl('http://192.0.2.10/a').hostname).toBe('192.0.2.10');
    expect(assertPublicUrl('https://public.example/a').protocol).toBe('https:');
    expect(assertPublicUrl('https://public.example:443/a').hostname).toBe('public.example');
    expect(assertPublicUrl('https://public.example/a#frag').hash).toBe('');
  });
});

describe('ssrf allowlist', () => {
  it('allows internal sonargate by default including custom ports', () => {
    expect(assertPublicUrl('http://sonargate/v1/collect').hostname).toBe('sonargate');
    expect(assertPublicUrl('http://sonargate:8080/v1/collect').port).toBe('8080');
    expect(assertPublicUrl('https://SONARGATE:8443/health').hostname).toBe('sonargate');
  });

  it('supports hostnames, host:port, wildcards, IPs, CIDRs, and URLs in allowlist', () => {
    const allowlist = parseSsrfAllowlist(
      'geo-obs.internal:9000, *.svc.local, 10.20.0.0/16, 192.168.1.50:8080, http://gateway.local:3000/api, [fc00::1]:8443',
      { includeDefaults: false },
    );

    expect(assertPublicUrl('http://geo-obs.internal:9000/collect', { allowlist }).port).toBe(
      '9000',
    );
    expect(() => assertPublicUrl('http://geo-obs.internal:9001/collect', { allowlist })).toThrow(
      UrlPolicyError,
    );

    expect(assertPublicUrl('http://sonargate.svc.local:8080/collect', { allowlist }).hostname).toBe(
      'sonargate.svc.local',
    );
    expect(assertPublicUrl('http://10.20.1.5:8080/v1', { allowlist }).hostname).toBe('10.20.1.5');
    expect(() => assertPublicUrl('http://10.21.1.5:8080/v1', { allowlist })).toThrow(
      UrlPolicyError,
    );

    expect(assertPublicUrl('http://192.168.1.50:8080/v1', { allowlist }).port).toBe('8080');
    expect(() => assertPublicUrl('http://192.168.1.50:9090/v1', { allowlist })).toThrow(
      UrlPolicyError,
    );

    expect(assertPublicUrl('http://gateway.local:3000/collect', { allowlist }).hostname).toBe(
      'gateway.local',
    );
    expect(assertPublicUrl('https://[fc00::1]:8443/collect', { allowlist }).port).toBe('8443');
  });

  it('does not allow metadata.google.internal via wildcard suffix', () => {
    const allowlist = parseSsrfAllowlist('*.internal', { includeDefaults: false });
    expect(assertPublicUrl('http://sonargate.internal:8080/v1', { allowlist }).hostname).toBe(
      'sonargate.internal',
    );
    expect(() => assertPublicUrl('http://metadata.google.internal/', { allowlist })).toThrow(
      UrlPolicyError,
    );
  });
});
