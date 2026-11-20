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

export const DEFAULT_SSRF_ALLOWLIST = ['sonargate'] as const;

export type IpFamily = 4 | 6;

export type ResolvedAddress = {
  address: string;
  family: IpFamily;
};

export type SsrfAllowlist = {
  exactHosts: Set<string>;
  wildcardSuffixes: string[];
  hostPorts: Map<string, Set<string>>;
  wildcardHostPorts: Array<{ suffix: string; port: string }>;
  ipList: BlockList;
  ipPorts: Map<string, Set<string>>;
};

export type SsrfPolicyOptions = {
  allowlist?: SsrfAllowlist | string;
};

export function parseSsrfAllowlist(
  raw: string | undefined = process.env.SSRF_ALLOWLIST,
  options?: { includeDefaults?: boolean },
): SsrfAllowlist {
  const allowlist: SsrfAllowlist = {
    exactHosts: new Set<string>(),
    wildcardSuffixes: [],
    hostPorts: new Map<string, Set<string>>(),
    wildcardHostPorts: [],
    ipList: new BlockList(),
    ipPorts: new Map<string, Set<string>>(),
  };

  const tokens: string[] = [];
  if (options?.includeDefaults !== false) {
    tokens.push(...DEFAULT_SSRF_ALLOWLIST);
  }
  if (raw) {
    for (const part of raw.split(/[\s,]+/)) {
      const trimmed = part.trim();
      if (trimmed) tokens.push(trimmed);
    }
  }

  for (const token of tokens) {
    addAllowlistToken(allowlist, token);
  }

  return allowlist;
}

export function resolveSsrfAllowlist(allowlist?: SsrfAllowlist | string): SsrfAllowlist {
  if (allowlist === undefined) return parseSsrfAllowlist();
  if (typeof allowlist === 'string') return parseSsrfAllowlist(allowlist);
  return allowlist;
}

export function isHostAllowlisted(
  hostname: string,
  port: string,
  allowlist: SsrfAllowlist,
): boolean {
  const host = normalizeHost(hostname);
  if (!host || host.includes('%')) return false;

  if (allowlist.exactHosts.has(host)) return true;
  if (port && allowlist.hostPorts.get(host)?.has(port)) return true;

  if (!BLOCKED_HOSTS.has(host)) {
    if (allowlist.wildcardSuffixes.some((suffix) => host.endsWith(suffix))) return true;
    if (
      port &&
      allowlist.wildcardHostPorts.some(
        (entry) => host.endsWith(entry.suffix) && entry.port === port,
      )
    ) {
      return true;
    }
  }

  const v4 = parseIPv4Literal(host);
  if (v4) {
    if (allowlist.ipList.check(v4, 'ipv4')) return true;
    if (port && allowlist.ipPorts.get(v4)?.has(port)) return true;
  }

  if (isIP(host) === 6) {
    if (allowlist.ipList.check(host, 'ipv6')) return true;
    if (port && allowlist.ipPorts.get(host)?.has(port)) return true;
  }

  return false;
}

export function isIpAllowlisted(address: string, port: string, allowlist: SsrfAllowlist): boolean {
  const family = isIP(address);
  if (family !== 4 && family !== 6) return false;
  const normalized = address.toLowerCase();
  if (allowlist.ipList.check(normalized, family === 4 ? 'ipv4' : 'ipv6')) return true;
  if (port && allowlist.ipPorts.get(normalized)?.has(port)) return true;
  if (family === 6) {
    const embedded = embeddedIpv4(normalized);
    if (embedded && allowlist.ipList.check(embedded, 'ipv4')) return true;
    if (embedded && port && allowlist.ipPorts.get(embedded)?.has(port)) return true;
  }
  return false;
}

function addAllowlistToken(allowlist: SsrfAllowlist, token: string): void {
  let hostPart = token.trim();
  let portPart = '';

  if (/^https?:\/\//i.test(hostPart)) {
    try {
      const parsed = new URL(hostPart);
      hostPart = parsed.hostname;
      portPart = parsed.port;
    } catch {
      return;
    }
  } else {
    const bracketed = hostPart.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (bracketed?.[1]) {
      hostPart = bracketed[1];
      portPart = bracketed[2] ?? '';
    } else if (!hostPart.includes('/')) {
      const hostPort = hostPart.match(/^([^:]+):(\d+)$/);
      if (hostPort?.[1] && hostPort[2]) {
        hostPart = hostPort[1];
        portPart = hostPort[2];
      }
    }
  }

  const host = normalizeHost(hostPart);
  if (!host) return;

  if (!portPart && host.includes('/')) {
    const cidr = host.match(/^(.+)\/(\d+)$/);
    if (cidr?.[1] && cidr[2]) {
      const prefix = Number(cidr[2]);
      const netFamily = isIP(cidr[1]);
      if (netFamily === 4 && Number.isInteger(prefix) && prefix >= 0 && prefix <= 32) {
        allowlist.ipList.addSubnet(cidr[1], prefix, 'ipv4');
        return;
      }
      if (netFamily === 6 && Number.isInteger(prefix) && prefix >= 0 && prefix <= 128) {
        allowlist.ipList.addSubnet(cidr[1], prefix, 'ipv6');
        return;
      }
    }
  }

  const v4 = parseIPv4Literal(host);
  if (v4) {
    if (portPart) {
      addPortEntry(allowlist.ipPorts, v4, portPart);
    } else {
      allowlist.ipList.addAddress(v4, 'ipv4');
    }
    return;
  }

  if (isIP(host) === 6) {
    if (portPart) {
      addPortEntry(allowlist.ipPorts, host, portPart);
    } else {
      allowlist.ipList.addAddress(host, 'ipv6');
    }
    return;
  }

  if (host.startsWith('*.') && host.length > 2) {
    const suffix = host.slice(1);
    if (portPart) {
      allowlist.wildcardHostPorts.push({ suffix, port: portPart });
    } else {
      allowlist.wildcardSuffixes.push(suffix);
    }
    return;
  }

  if (portPart) {
    addPortEntry(allowlist.hostPorts, host, portPart);
  } else {
    allowlist.exactHosts.add(host);
  }
}

function addPortEntry(map: Map<string, Set<string>>, key: string, port: string): void {
  const existing = map.get(key);
  if (existing) {
    existing.add(port);
    return;
  }
  map.set(key, new Set([port]));
}

function normalizeHost(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

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
  options?: { allowlisted?: boolean },
):
  | { kind: 'name' }
  | { kind: 'ip'; address: ResolvedAddress }
  | { kind: 'blocked'; reason: string } {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host || host.includes('%')) return { kind: 'blocked', reason: 'invalid_host' };
  if (
    !options?.allowlisted &&
    (BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix)))
  ) {
    return { kind: 'blocked', reason: 'reserved_name' };
  }
  const v4 = parseIPv4Literal(host);
  if (v4) {
    if (!options?.allowlisted) {
      const reason = ipBlockReason(v4);
      if (reason) return { kind: 'blocked', reason };
    }
    return { kind: 'ip', address: { address: v4, family: 4 } };
  }
  if (looksNumericHost(host)) return { kind: 'blocked', reason: 'invalid_ip_literal' };
  if (isIP(host) === 6) {
    if (!options?.allowlisted) {
      const reason = ipBlockReason(host);
      if (reason) return { kind: 'blocked', reason };
    }
    return { kind: 'ip', address: { address: host, family: 6 } };
  }
  if (host.includes(':')) return { kind: 'blocked', reason: 'invalid_ip_literal' };
  return { kind: 'name' };
}

export function assertPublicUrl(raw: string | URL, options?: SsrfPolicyOptions): URL {
  const url = typeof raw === 'string' ? parseUrl(raw) : raw;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw urlError('unsupported_scheme');
  }
  if (url.username || url.password) throw urlError('userinfo');
  const allowlist = resolveSsrfAllowlist(options?.allowlist);
  const effectivePort = url.port || (url.protocol === 'https:' ? '443' : '80');
  const allowlisted = isHostAllowlisted(url.hostname, effectivePort, allowlist);
  if (!allowlisted && url.port !== '' && url.port !== '80' && url.port !== '443') {
    throw urlError('port');
  }
  const classified = classifyHostname(url.hostname, { allowlisted });
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
