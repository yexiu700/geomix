import { BlockList, isIP } from 'node:net';

/**
 * 公开网页抓取的地址校验。字符串看起来像公网地址不够，解析后的每一个 IPv4 / IPv6 都要过这份名单。
 * 调用方还必须把连接钉在已经通过校验的地址上，避免检查之后 DNS 重新解析到内网。
 */

const blocked = new BlockList();
blocked.addSubnet('0.0.0.0', 8, 'ipv4');
blocked.addSubnet('10.0.0.0', 8, 'ipv4');
blocked.addSubnet('100.64.0.0', 10, 'ipv4');
blocked.addSubnet('127.0.0.0', 8, 'ipv4');
blocked.addSubnet('169.254.0.0', 16, 'ipv4');
blocked.addSubnet('172.16.0.0', 12, 'ipv4');
blocked.addSubnet('192.168.0.0', 16, 'ipv4');
blocked.addSubnet('224.0.0.0', 4, 'ipv4');
blocked.addSubnet('240.0.0.0', 4, 'ipv4');
blocked.addAddress('255.255.255.255', 'ipv4');
blocked.addAddress('::', 'ipv6');
blocked.addAddress('::1', 'ipv6');
blocked.addSubnet('fc00::', 7, 'ipv6');
blocked.addSubnet('fe80::', 10, 'ipv6');
blocked.addSubnet('ff00::', 8, 'ipv6');
blocked.addSubnet('64:ff9b:1::', 48, 'ipv6');

const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
]);

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.localdomain', '.internal', '.arpa'];

export type IpFamily = 4 | 6;

export type ResolvedAddress = {
  address: string;
  family: IpFamily;
};

export function ipBlockReason(address: string): string | null {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4') ? 'ipv4_special' : null;
  if (family !== 6) return 'invalid_ip';
  const embedded = embeddedIpv4(address);
  if (embedded) {
    const inner = ipBlockReason(embedded);
    if (inner) return `embedded_${inner}`;
  }
  if (blocked.check(address, 'ipv6')) return 'ipv6_special';
  return null;
}

export function isBlockedIp(address: string): boolean {
  return ipBlockReason(address) !== null;
}

/** 把十进制、十六进制、八进制和省略写法还原成点分 IPv4。不像 IP 的主机名返回 null。 */
export function parseIPv4Literal(hostname: string): string | null {
  const host = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  if (host.includes(':') || host.includes('%')) return null;
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  if (!parts.every((part) => part.length > 0)) return null;
  if (!looksNumericHost(host)) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    const value = parseIPv4Part(part);
    if (value === null) return null;
    numbers.push(value);
  }
  const packed = packIPv4(numbers);
  if (packed === null) return null;
  return intToIpv4(packed);
}

export function classifyHostname(
  hostname: string,
):
  | { kind: 'name' }
  | { kind: 'ip'; address: ResolvedAddress }
  | { kind: 'blocked'; reason: string } {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host || host.includes('%')) return { kind: 'blocked', reason: 'invalid_host' };
  if (BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { kind: 'blocked', reason: 'reserved_name' };
  }
  const v4 = parseIPv4Literal(host);
  if (v4) {
    const reason = ipBlockReason(v4);
    if (reason) return { kind: 'blocked', reason };
    return { kind: 'ip', address: { address: v4, family: 4 } };
  }
  if (looksNumericHost(host)) return { kind: 'blocked', reason: 'invalid_ip_literal' };
  if (isIP(host) === 6) {
    const reason = ipBlockReason(host);
    if (reason) return { kind: 'blocked', reason };
    return { kind: 'ip', address: { address: host, family: 6 } };
  }
  if (host.includes(':')) return { kind: 'blocked', reason: 'invalid_ip_literal' };
  return { kind: 'name' };
}

export function assertPublicUrl(raw: string | URL): URL {
  const url = typeof raw === 'string' ? parseUrl(raw) : raw;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw urlError('unsupported_scheme');
  }
  if (url.username || url.password) throw urlError('userinfo');
  if (url.port !== '' && url.port !== '80' && url.port !== '443') throw urlError('port');
  const classified = classifyHostname(url.hostname);
  if (classified.kind === 'blocked') throw urlError(classified.reason);
  url.hash = '';
  return url;
}

export class UrlPolicyError extends Error {
  constructor(readonly reason: string) {
    super('目标地址不允许访问');
    this.name = 'UrlPolicyError';
  }
}

function urlError(reason: string): UrlPolicyError {
  return new UrlPolicyError(reason);
}

function parseUrl(raw: string): URL {
  if (raw.length > 2048) throw urlError('url_length');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw urlError('invalid_url');
  }
  return url;
}

function looksNumericHost(host: string): boolean {
  return host.split('.').every((part) => /^0x[0-9a-f]+$/i.test(part) || /^\d+$/.test(part));
}

function parseIPv4Part(part: string): number | null {
  if (/^0x[0-9a-f]+$/i.test(part)) {
    if (part.length === 2) return null;
    const value = Number.parseInt(part.slice(2), 16);
    return Number.isSafeInteger(value) ? value : null;
  }
  if (part.length > 1 && part.startsWith('0')) {
    if (!/^[0-7]+$/.test(part)) return null;
    const value = Number.parseInt(part, 8);
    return Number.isSafeInteger(value) ? value : null;
  }
  if (!/^\d+$/.test(part)) return null;
  const value = Number(part);
  return Number.isSafeInteger(value) ? value : null;
}

function packIPv4(parts: number[]): number | null {
  const limits = [0xff, 0xff_ffff, 0xffff, 0xff];
  if (parts.length === 1) {
    const value = parts[0] ?? 0;
    return value <= 0xffff_ffff ? value : null;
  }
  if (parts.length === 2) {
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    const limit = limits[1] ?? 0;
    if (a > 0xff || b > limit) return null;
    return a * 2 ** 24 + b;
  }
  if (parts.length === 3) {
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    const c = parts[2] ?? 0;
    if (a > 0xff || b > 0xff || c > 0xffff) return null;
    return a * 2 ** 24 + b * 2 ** 16 + c;
  }
  const octets = parts.slice(0, 4);
  if (octets.some((part) => part > 0xff)) return null;
  return octets.reduce((total, part) => total * 256 + part, 0);
}

function intToIpv4(value: number): string {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

function embeddedIpv4(ipv6: string): string | null {
  const lower = ipv6.toLowerCase();
  const dotted = lower.match(/::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted?.[1]) return dotted[1];
  const mapped = lower.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped?.[1] && mapped[2]) {
    return intToIpv4((Number.parseInt(mapped[1], 16) << 16) + Number.parseInt(mapped[2], 16));
  }
  if (lower.startsWith('2002:')) {
    const pieces = lower.split(':');
    const hi = Number.parseInt(pieces[1] ?? '', 16);
    const lo = Number.parseInt(pieces[2] ?? '', 16);
    if (Number.isFinite(hi) && Number.isFinite(lo)) return intToIpv4((hi << 16) + lo);
  }
  if (lower.startsWith('64:ff9b::')) {
    const tail = lower.slice('64:ff9b::'.length);
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(tail)) return tail;
    const pieces = tail.split(':');
    if (pieces.length === 2 && pieces[0] && pieces[1]) {
      const hi = Number.parseInt(pieces[0], 16);
      const lo = Number.parseInt(pieces[1], 16);
      if (Number.isFinite(hi) && Number.isFinite(lo)) return intToIpv4((hi << 16) + lo);
    }
  }
  return null;
}
