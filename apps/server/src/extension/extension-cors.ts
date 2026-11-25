/**
 * L2 Chrome 扩展桥接的受控 CORS 工具（Issue #371）：
 * - 仅允许合法 Chrome Web Store 扩展 ID（32 位小写 a-p）访问 3 个薄桥接路径；
 * - 严禁通配符 `*`、严禁对控制台/计费/管理/令牌管理接口开放扩展来源、严禁为扩展来源下发 `Access-Control-Allow-Credentials`；
 * - 显式处理未匹配来源的预检请求（返回 403 且不附带任何 `Access-Control-*` 头），配合动态 `app.enableCors` 彻底避免 `cors@2.8.5` 凭据头泄漏。
 */

export const CHROME_EXTENSION_ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/;

/**
 * 仅精确放行 3 个 L2 扩展桥接路径：
 * - /api/v2/extension/me
 * - /api/v2/extension/tasks
 * - /api/v2/extension/tasks/:taskId/confirm-published
 *
 * 参数段限定 `[A-Za-z0-9_-]{1,64}`，天然阻断 `.`、`..`、`%2e`、`%2f`、`//`、`\` 等路径穿越形态。
 */
export const EXTENSION_BRIDGE_CORS_PATH_RE =
  /^\/api\/v2\/extension\/(?:me|tasks|tasks\/[A-Za-z0-9_-]{1,64}\/confirm-published)\/?$/;

export const EXTENSION_BRIDGE_CORS_ALLOW_METHODS = 'GET, POST, OPTIONS';
export const EXTENSION_BRIDGE_CORS_ALLOW_HEADERS =
  'Authorization, Content-Type, Idempotency-Key, X-GeoMix-Extension-Version';

export type CorsRequestLike = {
  method?: string;
  url?: string;
  originalUrl?: string;
  headers?: Record<string, unknown>;
};

export type CorsResponseLike = {
  statusCode: number;
  getHeader?(name: string): string | number | string[] | undefined;
  setHeader(name: string, value: string | string[]): void;
  end(): void;
};

export function isAllowedChromeExtensionOrigin(origin: string): boolean {
  return CHROME_EXTENSION_ORIGIN_RE.test(origin);
}

export function isExtensionBridgeCorsPath(rawUrl: string): boolean {
  const pathname = rawUrl.split('?', 1)[0] ?? '';
  return EXTENSION_BRIDGE_CORS_PATH_RE.test(pathname);
}

/**
 * 严格读取单个原始 `Origin` 头；若缺失、空串或出现重复头（数组）则返回 `null`。
 * 不做 trim，防止前后空白绕过正则锚点。
 */
export function readSingleOriginHeader(req: CorsRequestLike | undefined | null): string | null {
  const raw = req?.headers?.origin;
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }
  return raw;
}

export function appendVaryOrigin(res: CorsResponseLike): void {
  const existing = typeof res.getHeader === 'function' ? res.getHeader('Vary') : undefined;
  if (existing === undefined || existing === null || existing === '') {
    res.setHeader('Vary', 'Origin');
    return;
  }
  const rawList = Array.isArray(existing) ? existing.join(',') : String(existing);
  const tokens = rawList
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (tokens.some((token) => token.toLowerCase() === 'origin')) {
    return;
  }
  tokens.push('Origin');
  res.setHeader('Vary', tokens.join(', '));
}

export function createExtensionBridgeCorsMiddleware(
  webOriginSet: ReadonlySet<string>,
): (req: CorsRequestLike, res: CorsResponseLike, next: () => void) => void {
  return (req, res, next) => {
    const rawOrigin = req?.headers?.origin;
    const isPreflight = req.method?.toUpperCase() === 'OPTIONS';

    if (Array.isArray(rawOrigin)) {
      appendVaryOrigin(res);
      if (isPreflight) {
        res.statusCode = 403;
        res.setHeader('Content-Length', '0');
        res.end();
        return;
      }
      next();
      return;
    }

    const origin = readSingleOriginHeader(req);
    if (!origin || webOriginSet.has(origin)) {
      next();
      return;
    }

    appendVaryOrigin(res);

    const rawUrl = req.originalUrl ?? req.url ?? '';

    if (isExtensionBridgeCorsPath(rawUrl) && isAllowedChromeExtensionOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      if (isPreflight) {
        res.setHeader('Access-Control-Allow-Methods', EXTENSION_BRIDGE_CORS_ALLOW_METHODS);
        res.setHeader('Access-Control-Allow-Headers', EXTENSION_BRIDGE_CORS_ALLOW_HEADERS);
        res.statusCode = 204;
        res.end();
        return;
      }
      next();
      return;
    }

    if (isPreflight) {
      res.statusCode = 403;
      res.setHeader('Content-Length', '0');
      res.end();
      return;
    }

    next();
  };
}
