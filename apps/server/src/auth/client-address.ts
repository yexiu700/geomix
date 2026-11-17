import { isIP } from 'node:net';

type ProxyRequest = {
  socket?: { remoteAddress?: string | null };
  headers?: Record<string, string | string[] | undefined>;
  header?: (name: string) => string | undefined;
};

type TrustProxyRules = {
  enabled: boolean;
  loopback: boolean;
  privateRanges: boolean;
  explicitIps: Set<string>;
};

/**
 * 默认仅取 TCP 对端地址，避免直连客户端伪造转发头换桶。
 * 当显式开启 AUTH_TRUST_PROXY 且对端属于受信任反代（如本机或容器私网 Nginx）时，
 * 优先解析 X-Real-IP，其次从右向左解析 X-Forwarded-For 中的真实客户端 IP。
 */
export function clientAddress(
  request: unknown,
  env: Record<string, string | undefined> = process.env,
): string {
  if (!request || typeof request !== 'object') return 'unknown';
  const req = request as ProxyRequest;
  const remote = normalizeAddress(req.socket?.remoteAddress ?? '');
  const rules = parseTrustProxy(env.AUTH_TRUST_PROXY);
  if (!rules.enabled || !isTrustedProxyAddress(remote, rules)) {
    return remote;
  }

  const realIp = readSingleHeader(req, 'x-real-ip');
  if (realIp) {
    const normalizedRealIp = normalizeAddress(realIp);
    if (isValidIp(normalizedRealIp)) {
      return normalizedRealIp;
    }
  }

  const forwardedFor = readSingleHeader(req, 'x-forwarded-for');
  if (forwardedFor) {
    const chain = forwardedFor
      .split(',')
      .map((entry) => normalizeAddress(entry))
      .filter((entry) => isValidIp(entry));
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const candidate = chain[i]!;
      if (!isTrustedProxyAddress(candidate, rules)) {
        return candidate;
      }
    }
    if (chain.length > 0) {
      return chain[chain.length - 1]!;
    }
  }

  return remote;
}

export function normalizeAddress(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('::ffff:')) return value.slice('::ffff:'.length);
  return value.length > 0 ? value : 'unknown';
}

function isValidIp(value: string): boolean {
  return value !== 'unknown' && isIP(value) !== 0;
}

function readSingleHeader(req: ProxyRequest, lowerName: string): string | undefined {
  if (typeof req.header === 'function') {
    const viaMethod = req.header(lowerName);
    if (typeof viaMethod === 'string' && viaMethod.trim().length > 0) {
      return viaMethod;
    }
  }
  const raw = req.headers?.[lowerName];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw.length > 0) return raw.join(', ');
  return undefined;
}

function parseTrustProxy(raw: string | undefined): TrustProxyRules {
  const cleaned = (raw ?? '').trim().toLowerCase();
  if (!cleaned || cleaned === 'false' || cleaned === '0' || cleaned === 'off' || cleaned === 'no') {
    return { enabled: false, loopback: false, privateRanges: false, explicitIps: new Set() };
  }
  if (cleaned === 'true' || cleaned === '1' || cleaned === 'yes' || cleaned === 'on') {
    return { enabled: true, loopback: true, privateRanges: true, explicitIps: new Set() };
  }

  let loopback = false;
  let privateRanges = false;
  const explicitIps = new Set<string>();
  for (const token of cleaned
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    if (token === 'loopback') {
      loopback = true;
    } else if (token === 'private' || token === 'uniquelocal') {
      privateRanges = true;
    } else {
      const normalized = normalizeAddress(token);
      if (isValidIp(normalized)) {
        explicitIps.add(normalized.toLowerCase());
      }
    }
  }
  const enabled = loopback || privateRanges || explicitIps.size > 0;
  return { enabled, loopback, privateRanges, explicitIps };
}

export function isTrustedProxyAddress(ip: string, rules: TrustProxyRules): boolean {
  if (!isValidIp(ip)) return false;
  const lower = ip.toLowerCase();
  if (rules.explicitIps.has(lower)) return true;
  if (rules.loopback && isLoopbackIp(lower)) return true;
  if (rules.privateRanges && isPrivateIp(lower)) return true;
  return false;
}

function isLoopbackIp(ip: string): boolean {
  return ip === '::1' || ip.startsWith('127.');
}

function isPrivateIp(ip: string): boolean {
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
  if (ip.startsWith('172.')) {
    const secondOctet = Number(ip.split('.')[1]);
    if (Number.isInteger(secondOctet) && secondOctet >= 16 && secondOctet <= 31) {
      return true;
    }
  }
  if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:')) {
    return true;
  }
  return false;
}
