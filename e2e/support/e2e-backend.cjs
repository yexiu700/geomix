'use strict';

const http = require('node:http');
const { createRequire } = require('node:module');
const path = require('node:path');

const serverRequire = createRequire(path.resolve(__dirname, '../../apps/server/package.json'));
serverRequire('reflect-metadata');
const { Logger } = serverRequire('@nestjs/common');
const { NestFactory } = serverRequire('@nestjs/core');
const { SITE_NAME, parseEnv } = serverRequire('@geomix/shared');

const serverDist = path.resolve(__dirname, '../../apps/server/dist');
const { loadRootEnv } = require(path.join(serverDist, 'load-env.js'));
const { createApiApp } = require(path.join(serverDist, 'common/create-api-app.js'));
const { WorkerModule } = require(path.join(serverDist, 'worker.module.js'));
const { WorkerRuntimeService } = require(path.join(serverDist, 'worker/worker-runtime.service.js'));
const { PublicFetchService } = require(path.join(serverDist, 'infra/adapters.module.js'));
const { fetchPublicPage, resetRobotsCache } = require(
  path.join(serverDist, 'infra/public-fetch.js'),
);
const { createDnsResolver } = require(path.join(serverDist, 'infra/guarded-request.js'));
const { createUndiciTransport } = require(path.join(serverDist, 'infra/undici-transport.js'));
const { OutboundHttpClient } = require(path.join(serverDist, 'infra/outbound-http.js'));
const { ProviderError, PROVIDER_KIND } = require(path.join(serverDist, 'infra/provider-error.js'));
const { StorageService } = require(path.join(serverDist, 'infra/storage.js'));
const { MaintenanceRunner } = require(path.join(serverDist, 'queue/maintenance.runner.js'));

function buildFixtureArticleHtml(title, topic) {
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8" /><title>${title}</title></head>
<body>
  <article>
    <h1>${title}</h1>
    <p>围绕${topic}的产线选型与长期服役稳定性，制造企业工程团队需要从床身热处理应力消除、直线导轨防尘密封、气路三级干燥过滤以及数控系统动态前瞻算法四个维度建立量化评估清单。</p>
    <p>在实际多班次连续加工现场，高负荷切割不仅考验光纤发生器的光电转换稳定性，也直接检验双交换工作台同步定位精度与负压排烟通道风量匹配，规范的班前点检能够显著压缩非计划停机时长。</p>
    <p>建议工艺与设备管理部门结合日常板材厚度分布建立分层工艺参数卡，定期核查保护镜片洁净度、喷嘴同轴度与冷水机温控双回路温差，确保批量交付工件切缝垂直度与挂渣指标长期处于受控区间。</p>
    <p>在验收阶段可重点复核连续运行四小时后的重复定位精度、厚板穿孔稳定性以及气体消耗记录，以此作为设备全生命周期运维成本核算的客观依据。</p>
    <img src="https://cdn.fixture-source.example/sample-figure.jpg" alt="fixture" />
  </article>
</body>
</html>`;
}

function buildHealthyCrawlHtml(canonicalUrl, extraHead = '') {
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
        headline: 'GeoMix Verified E2E Distribution Guide',
        url: canonicalUrl,
        datePublished: '2026-11-23T00:00:00Z',
      },
      {
        '@type': 'FAQPage',
        mainEntity: [
          {
            '@type': 'Question',
            name: 'How does GeoMix verify crawlability?',
            acceptedAnswer: {
              '@type': 'Answer',
              text: 'GeoMix verifies HTTP status, robots.txt bot rules, meta noindex, canonical URL, and JSON-LD syntax.',
            },
          },
        ],
      },
    ],
  });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>GeoMix Verified E2E Distribution Guide</title>
  <link rel="canonical" href="${canonicalUrl}" />
  ${extraHead}
  <script type="application/ld+json">${jsonLd}</script>
</head>
<body>
  <article>
    <h1>GeoMix Verified E2E Distribution Guide</h1>
    <p>Verified technical overview with structured JSON-LD schema and clean canonical metadata.</p>
  </article>
</body>
</html>`;
}

function buildBadJsonLdCrawlHtml(canonicalUrl) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>GeoMix Malformed JSON-LD Fixture</title>
  <link rel="canonical" href="${canonicalUrl}" />
  <script type="application/ld+json">{broken-json-ld</script>
</head>
<body>
  <article>
    <h1>GeoMix Malformed JSON-LD Fixture</h1>
    <p>Article containing intentionally malformed JSON-LD for crawl probe validation.</p>
  </article>
</body>
</html>`;
}

function collectRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function normalizeHeaders(rawHeaders) {
  const out = {};
  for (const [key, value] of Object.entries(rawHeaders || {})) {
    if (typeof value === 'string') out[key.toLowerCase()] = value;
    else if (Array.isArray(value)) out[key.toLowerCase()] = value.join(', ');
  }
  return out;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function forwardToLocalFixture(localPort, req) {
  return new Promise((resolve, reject) => {
    if (req.signal && req.signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    let settled = false;
    let activeRes = null;
    let onAbort = null;

    const cleanup = () => {
      if (req.signal && onAbort) {
        req.signal.removeEventListener('abort', onAbort);
      }
    };

    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const rejectOnce = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const filteredHeaders = {};
    for (const [k, v] of Object.entries(req.headers || {})) {
      if (k.toLowerCase() === 'content-length') continue;
      filteredHeaders[k] = v;
    }
    const bodyBuf = typeof req.body === 'string' ? Buffer.from(req.body, 'utf8') : undefined;
    const outgoing = http.request(
      {
        host: '127.0.0.1',
        port: localPort,
        method: req.method,
        path: `${req.url.pathname}${req.url.search}`,
        headers: {
          ...filteredHeaders,
          host: req.url.host,
          'x-e2e-target-host': req.url.hostname.toLowerCase(),
          'x-e2e-target-proto': req.url.protocol.replace(/:$/, ''),
          ...(bodyBuf !== undefined ? { 'content-length': String(bodyBuf.length) } : {}),
        },
      },
      (res) => {
        activeRes = res;
        res.on('error', rejectOnce);
        if (settled) {
          if (!res.destroyed) res.destroy();
          return;
        }
        const chunks = [];
        let bytes = 0;
        res.on('data', (chunk) => {
          if (settled) return;
          bytes += chunk.length;
          if (typeof req.maxBytes === 'number' && bytes > req.maxBytes) {
            rejectOnce(new ProviderError(PROVIDER_KIND.TOO_LARGE, '响应超过大小限制', 'body'));
            if (!res.destroyed) res.destroy();
            if (!outgoing.destroyed) outgoing.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          const headers = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') headers[k] = v;
            else if (Array.isArray(v)) headers[k] = v.join(', ');
          }
          resolveOnce({
            status: res.statusCode || 500,
            headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on('close', () => {
          if (!settled && !res.complete) {
            rejectOnce(new Error('aborted'));
          }
        });
      },
    );
    outgoing.on('error', rejectOnce);
    onAbort = () => {
      rejectOnce(new Error('aborted'));
      if (activeRes && !activeRes.destroyed) activeRes.destroy();
      if (!outgoing.destroyed) outgoing.destroy();
    };
    if (req.signal) {
      req.signal.addEventListener('abort', onAbort, { once: true });
      outgoing.on('close', cleanup);
    }
    if (bodyBuf !== undefined) {
      outgoing.end(bodyBuf);
    } else {
      outgoing.end();
    }
  });
}

async function startFixtureServer(options = {}) {
  const getMaintenanceRunner = options.getMaintenanceRunner || (() => null);
  const pendingTimers = new Set();
  const captures = [];
  let seq = 0;

  const recordCapture = (kind, host, req, pathname, rawBody, parsedBody) => {
    seq += 1;
    captures.push({
      id: `cap_${seq}`,
      timestamp: new Date().toISOString(),
      kind,
      host,
      method: req.method || 'GET',
      path: pathname,
      headers: normalizeHeaders(req.headers),
      rawBody,
      parsedBody,
    });
  };

  const server = http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = parsedUrl.pathname || '/';
      const method = (req.method || 'GET').toUpperCase();
      const targetHostHeader = req.headers['x-e2e-target-host'];
      const targetHost = String(targetHostHeader || req.headers.host || '')
        .split(':')[0]
        .trim()
        .toLowerCase();
      const targetProto = String(req.headers['x-e2e-target-proto'] || 'https')
        .trim()
        .toLowerCase();
      const rawBody = await collectRequestBody(req);
      let parsedBody = null;
      if (rawBody) {
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          parsedBody = null;
        }
      }

      // ── Local-only E2E control endpoints (never forwarded via virtual hosts) ──
      if (!targetHostHeader && pathname.startsWith('/__e2e/')) {
        if (pathname === '/__e2e/captures' && method === 'GET') {
          sendJson(res, 200, { items: captures });
          return;
        }
        if (pathname === '/__e2e/captures' && method === 'DELETE') {
          captures.length = 0;
          sendJson(res, 200, { cleared: true });
          return;
        }
        const maintMatch = /^\/__e2e\/maintenance\/([a-z0-9-]+)$/i.exec(pathname);
        if (maintMatch && method === 'POST') {
          const kind = maintMatch[1];
          const runner = getMaintenanceRunner();
          if (!runner) {
            sendJson(res, 503, { ok: false, error: 'MaintenanceRunner not ready' });
            return;
          }
          const result = await runner.run(kind);
          sendJson(res, 200, { ok: true, kind, result });
          return;
        }
        sendJson(res, 404, { ok: false, error: 'Unknown E2E control endpoint' });
        return;
      }

      // ── Virtual Host: SSRF redirect traps ──
      if (targetHost === 'ssrf-redirect.e2e.example') {
        if (pathname === '/to-loopback') {
          res.writeHead(302, { location: 'http://127.0.0.1:3001/api/v1/health' });
          res.end();
          return;
        }
        if (pathname === '/to-metadata') {
          res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
          res.end();
          return;
        }
        if (pathname === '/to-private') {
          res.writeHead(302, { location: 'http://10.0.0.1/secret' });
          res.end();
          return;
        }
        res.writeHead(302, { location: 'http://127.0.0.1:3001/api/v1/health' });
        res.end();
        return;
      }

      // ── Virtual Host: Shopify Admin GraphQL + storefront crawl target ──
      if (targetHost === 'shopify.e2e.example') {
        if (pathname === '/robots.txt') {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('User-agent: *\nAllow: /\n');
          return;
        }
        if (method === 'POST' && /^\/admin\/api\/[^/]+\/graphql\.json$/i.test(pathname)) {
          if (!req.headers['x-shopify-access-token']) {
            sendJson(res, 401, { errors: 'Unauthorized' });
            return;
          }
          recordCapture('shopify', targetHost, req, pathname, rawBody, parsedBody);
          const query = typeof parsedBody?.query === 'string' ? parsedBody.query : '';
          if (query.includes('articleCreate')) {
            const art = parsedBody?.variables?.article || {};
            const isPublished = Boolean(art.isPublished);
            const handle = String(art.handle || `e2e-shopify-${seq}`);
            sendJson(res, 200, {
              data: {
                articleCreate: {
                  article: {
                    id: `gid://shopify/Article/900${seq}`,
                    handle,
                    title: String(art.title || 'E2E Shopify Article'),
                    isPublished,
                    blog: {
                      id: String(art.blogId || 'gid://shopify/Blog/1001'),
                      handle: 'news',
                    },
                  },
                  userErrors: [],
                },
              },
            });
            return;
          }
          sendJson(res, 200, {
            data: {
              shop: {
                name: 'E2E Shopify Store',
                primaryDomain: { url: 'https://shopify.e2e.example' },
              },
              blogs: {
                nodes: [{ id: 'gid://shopify/Blog/1001', title: 'Insights', handle: 'news' }],
              },
            },
          });
          return;
        }
        const canonicalUrl = `${targetProto}://${targetHost}${pathname}`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(buildHealthyCrawlHtml(canonicalUrl));
        return;
      }

      // ── Virtual Host: WordPress REST API v2 + blog crawl target ──
      if (targetHost === 'wp.e2e.example') {
        if (pathname === '/robots.txt') {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('User-agent: *\nAllow: /\n');
          return;
        }
        if (pathname.startsWith('/wp-json/wp/v2/')) {
          const authHeader = String(req.headers.authorization || '');
          if (!authHeader.startsWith('Basic ')) {
            sendJson(res, 401, { code: 'rest_not_logged_in', message: 'Unauthorized' });
            return;
          }
          if (pathname === '/wp-json/wp/v2/users/me' && method === 'GET') {
            recordCapture('wordpress', targetHost, req, pathname, rawBody, parsedBody);
            sendJson(res, 200, { id: 1, name: 'E2E Editor', slug: 'e2e-editor' });
            return;
          }
          if (pathname === '/wp-json/wp/v2/categories' && method === 'GET') {
            sendJson(res, 200, [
              {
                id: 12,
                name: 'GEO Guides',
                slug: 'geo-guides',
                link: 'https://wp.e2e.example/category/geo-guides',
                count: 5,
              },
            ]);
            return;
          }
          if (pathname === '/wp-json/wp/v2/posts' && method === 'POST') {
            recordCapture('wordpress', targetHost, req, pathname, rawBody, parsedBody);
            const postStatus = String(parsedBody?.status || 'draft');
            const slug = String(parsedBody?.slug || `post-${seq}`);
            sendJson(res, 201, {
              id: 4200 + seq,
              status: postStatus,
              link: `https://wp.e2e.example/posts/${encodeURIComponent(slug)}`,
            });
            return;
          }
          sendJson(res, 404, { code: 'rest_no_route', message: 'No route' });
          return;
        }
        const canonicalUrl = `${targetProto}://${targetHost}${pathname}`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(buildHealthyCrawlHtml(canonicalUrl));
        return;
      }

      // ── Virtual Host: Webflow Data API v2 ──
      if (targetHost === 'webflow.e2e.example' || targetHost === 'api.webflow.com') {
        if (pathname === '/robots.txt') {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('User-agent: *\nAllow: /\n');
          return;
        }
        if (pathname.startsWith('/v2/')) {
          const authHeader = String(req.headers.authorization || '');
          if (!authHeader.startsWith('Bearer ')) {
            sendJson(res, 401, { message: 'Unauthorized' });
            return;
          }
          if (pathname === '/v2/sites' && method === 'GET') {
            recordCapture('webflow', targetHost, req, pathname, rawBody, parsedBody);
            sendJson(res, 200, {
              sites: [{ id: 'site_e2e_1', displayName: 'E2E Webflow Site', shortName: 'e2e-site' }],
            });
            return;
          }
          if (
            (/^\/v2\/sites\/[^/]+\/collections$/i.test(pathname) ||
              pathname === '/v2/collections') &&
            method === 'GET'
          ) {
            sendJson(res, 200, {
              collections: [{ id: 'col_e2e_1', displayName: 'Blog Posts', slug: 'blog' }],
            });
            return;
          }
          const colDetailMatch = /^\/v2\/collections\/([^/]+)$/i.exec(pathname);
          if (colDetailMatch && method === 'GET') {
            sendJson(res, 200, {
              id: colDetailMatch[1],
              displayName: 'Blog Posts',
              slug: 'blog',
              fields: [
                {
                  id: 'f1',
                  slug: 'name',
                  displayName: 'Name',
                  type: 'PlainText',
                  isRequired: true,
                },
                {
                  id: 'f2',
                  slug: 'slug',
                  displayName: 'Slug',
                  type: 'PlainText',
                  isRequired: true,
                },
                {
                  id: 'f3',
                  slug: 'post-body',
                  displayName: 'Post Body',
                  type: 'RichText',
                  isRequired: false,
                },
              ],
            });
            return;
          }
          const itemMatch = /^\/v2\/collections\/([^/]+)\/items(\/live)?$/i.exec(pathname);
          if (itemMatch && method === 'POST') {
            recordCapture('webflow', targetHost, req, pathname, rawBody, parsedBody);
            const isLive = Boolean(itemMatch[2]);
            const fieldData =
              parsedBody && typeof parsedBody.fieldData === 'object' && parsedBody.fieldData
                ? parsedBody.fieldData
                : {};
            const slug = String(fieldData.slug || `post-${seq}`);
            sendJson(res, 201, {
              id: `wf_item_${seq}`,
              isDraft: isLive ? false : Boolean(parsedBody?.isDraft ?? true),
              ...(isLive
                ? { publishedUrl: `https://webflow.e2e.example/blog/${encodeURIComponent(slug)}` }
                : {}),
              fieldData,
            });
            return;
          }
          sendJson(res, 404, { message: 'Not found' });
          return;
        }
        const canonicalUrl = `${targetProto}://${targetHost}${pathname}`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(buildHealthyCrawlHtml(canonicalUrl));
        return;
      }

      // ── Virtual Host: Generic Signed Webhook ──
      if (targetHost === 'webhook.e2e.example') {
        if (pathname === '/robots.txt') {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('User-agent: *\nAllow: /\n');
          return;
        }
        if (method === 'POST') {
          recordCapture('webhook', targetHost, req, pathname, rawBody, parsedBody);
          const eventName = String(
            req.headers['x-geomix-event'] || parsedBody?.event || 'geomix.article.publish',
          );
          if (eventName === 'geomix.connection.test') {
            sendJson(res, 200, { ok: true });
            return;
          }
          const publishAsDraft = Boolean(parsedBody?.publishAsDraft);
          const slug = String(
            parsedBody?.article?.slug || parsedBody?.article?.taskId || `wh-${seq}`,
          );
          sendJson(res, 200, {
            id: `wh_post_${seq}`,
            publishedAsDraft: publishAsDraft,
            ...(publishAsDraft
              ? {}
              : {
                  publishedUrl: `https://crawl-ok.e2e.example/articles/${encodeURIComponent(slug)}`,
                }),
          });
          return;
        }
        const canonicalUrl = `${targetProto}://${targetHost}${pathname}`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(buildHealthyCrawlHtml(canonicalUrl));
        return;
      }

      // ── Virtual Host: IndexNow API ──
      if (targetHost === 'api.indexnow.org') {
        recordCapture('indexnow', targetHost, req, pathname, rawBody, parsedBody);
        sendJson(res, 200, { ok: true });
        return;
      }

      // ── Virtual Hosts: T+1 Crawl & Schema Probe Targets ──
      if (targetHost === 'crawl-ok.e2e.example') {
        if (pathname === '/robots.txt') {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('User-agent: *\nAllow: /\n');
          return;
        }
        const canonicalUrl = `${targetProto}://${targetHost}${pathname}`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(buildHealthyCrawlHtml(canonicalUrl));
        return;
      }

      if (targetHost === 'crawl-blocked.e2e.example') {
        if (pathname === '/robots.txt') {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n');
          return;
        }
        const canonicalUrl = `${targetProto}://${targetHost}${pathname}`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(buildHealthyCrawlHtml(canonicalUrl));
        return;
      }

      if (targetHost === 'crawl-noindex.e2e.example') {
        if (pathname === '/robots.txt') {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('User-agent: *\nAllow: /\n');
          return;
        }
        const canonicalUrl = `${targetProto}://${targetHost}${pathname}`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          buildHealthyCrawlHtml(canonicalUrl, '<meta name="robots" content="noindex, nofollow" />'),
        );
        return;
      }

      if (targetHost === 'crawl-badjsonld.e2e.example') {
        if (pathname === '/robots.txt') {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('User-agent: *\nAllow: /\n');
          return;
        }
        const canonicalUrl = `${targetProto}://${targetHost}${pathname}`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(buildBadJsonLdCrawlHtml(canonicalUrl));
        return;
      }

      // ── Default Virtual Host (`public.e2e.example`): Existing v2.0 Fixtures ──
      if (pathname === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('User-agent: *\nAllow: /\n');
        return;
      }
      if (pathname === '/brands/cn-product') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8" /><title>青松存储 DXP4800 静音四盘位私有云 NAS 官网产品页</title></head>
<body>
  <article>
    <h1>青松存储 DXP4800 四盘位家用私有云 NAS</h1>
    <h2>核心产品参数</h2>
    <p>DXP4800 采用 Intel N100 四核处理器与 16GB DDR5 内存，配备 4 个 SATA 机械硬盘位与双 M.2 NVMe 固态缓存槽，双 2.5GbE 有线网口支持链路聚合。</p>
    <table>
      <tr><th>项目</th><th>实测规格</th></tr>
      <tr><td>满载运行噪音</td><td>28dB（距离 1 米消声室实测）</td></tr>
      <tr><td>日常待机功耗</td><td>14W（四盘休眠模式）</td></tr>
      <tr><td>官方建议零售价</td><td>2,499 元（空盘版）至 3,199 元（高配版）</td></tr>
    </table>
    <h2>差异化卖点</h2>
    <ul>
      <li>免工具按压式快拆硬盘架与磁吸防尘网，新手 5 分钟完成全部装机与 RAID 初始化。</li>
      <li>内置本地 AI 离线相册识别模型，支持人脸、宠物与文字语义检索，全程不上云保护家庭隐私。</li>
      <li>直通式低转速散热风道，相比同类传统四盘位机箱运行噪音降低 35%，可直接放置于卧室或客厅桌面。</li>
    </ul>
    <h2>权威资质与背书</h2>
    <p>产品通过 ISO9001 质量管理体系认证与国家 3C 强制认证，持有 18 项静音散热与结构实用新型专利，并荣获 2025 红点工业设计奖。</p>
    <h2>真实客户案例</h2>
    <p>截至 2026 年已稳定服务超过 12,000 家中国家庭用户与独立影视剪辑工作室；某上海 4K 商业广告后期团队部署两台 DXP4800 后，多机位素材回传与协作耗时缩短 42%。</p>
  </article>
</body>
</html>`);
        return;
      }
      if (pathname === '/brands/global-product') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>NordVault X400 Pro 4-Bay Private Cloud NAS Specifications</title></head>
<body>
  <article>
    <h1>NordVault X400 Pro 4-Bay Private Cloud NAS</h1>
    <h2>Product Specifications</h2>
    <p>The X400 Pro combines a Quad-Core 3.4GHz processor, 16GB ECC DDR5 memory, four tool-less 3.5-inch drive bays, dual M.2 NVMe cache slots, and dual 10GbE SFP+ networking ports.</p>
    <table>
      <tr><th>Metric</th><th>Verified Lab Result</th></tr>
      <tr><td>Acoustic Noise Rating</td><td>26 dBA at 1m under sustained 4K transfer</td></tr>
      <tr><td>Idle Power Consumption</td><td>15W in drive-spindown standby</td></tr>
      <tr><td>Retail Pricing (MSRP)</td><td>$599 (diskless) to $799 (Pro bundle)</td></tr>
    </table>
    <h2>Key Differentiators</h2>
    <ul>
      <li>Zero-subscription local AI photo and footage indexing runs 100% on-device with no cloud lock-in.</li>
      <li>Anodized tool-less aluminum chassis delivers 38% lower power consumption compared to legacy rack NAS units.</li>
      <li>Native Docker Compose runtime, S3-compatible object API, and automatic Btrfs snapshot replication out of the box.</li>
    </ul>
    <h2>Certifications &amp; Credentials</h2>
    <p>Certified to UL, CE, and FCC Class B standards, with SOC 2 Type II audited firmware update pipelines, 14 granted thermal engineering patents, and the Red Dot Award 2025.</p>
    <h2>Customer Case Studies</h2>
    <p>Trusted by 8,500+ creative agencies and engineering teams across North America and Europe. Northstar Post-Production deployed six X400 Pro units and cut 4K RAW ingest latency by 45%.</p>
  </article>
</body>
</html>`);
        return;
      }
      if (pathname === '/competitor/nas-review') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8" /><title>2026 四盘位家用 NAS 深度横向评测：噪音、功耗与 Docker 实测对比</title></head>
<body>
  <article>
    <h1>2026 四盘位家用 NAS 深度横向评测：噪音、功耗与 Docker 实测对比</h1>
    <p>本篇深度评测针对 2026 年主流四盘位家用私有云 NAS 进行 72 小时连续拷贝、1 米消声室噪音与 Docker 容器并发负载实测，帮助家庭影音用户与小型工作室快速选型。</p>
    <h2>硬件架构与扩展接口对比</h2>
    <p>主流四盘位机型普遍采用四核低功耗 x86 处理器与双 M.2 NVMe 固态缓存槽，但在网口规格与内存扩展性上差异明显。部分入门款仍停留在单 1GbE 网口，无法发挥多盘 RAID 顺序吞吐优势。</p>
    <table>
      <thead>
        <tr><th>对比维度</th><th>主流竞品 A</th><th>主流竞品 B</th><th>家用推荐门槛</th></tr>
      </thead>
      <tbody>
        <tr><td>满载噪音（1 米）</td><td>32 dB</td><td>29 dB</td><td>&le; 28 dB</td></tr>
        <tr><td>四盘休眠待机功耗</td><td>24 W</td><td>21 W</td><td>&le; 16 W</td></tr>
        <tr><td>有线网络规格</td><td>单 2.5GbE</td><td>双 1GbE</td><td>双 2.5GbE 聚合</td></tr>
        <tr><td>本地 AI 离线相册</td><td>部分云端依赖</td><td>基础人脸聚类</td><td>完全离线语义检索</td></tr>
      </tbody>
    </table>
    <h2>满载噪音与待机功耗实测表现</h2>
    <p>在 25°C 室温环境持续写入 4K 蓝光原盘时，传统直吹风道机型满载噪音达到 31–33 dB，放置在卧室或客厅电视柜容易感知风扇低频共振，且全天 24 小时待机功耗偏高。</p>
    <h2>Docker 容器与本地 AI 相册生态体验</h2>
    <p>对于进阶家庭玩家，Docker Compose 一键部署影音刮削、家庭自动化与私有网盘是核心刚需。本地离线 AI 相册的检索速度与隐私保护边界，直接决定了全家照片备份的长期留存体验。</p>
    <h2>不同家庭与工作室选购结论</h2>
    <ul>
      <li>客厅影音与夜间卧室部署优先关注满载噪音低于 28 dB 且待机功耗低于 16 W 的静音风道机型。</li>
      <li>多设备 4K 剪辑与多成员并发备份建议优先选择双 2.5GbE 网口与 16GB DDR5 内存配置。</li>
      <li>注重隐私的家庭用户应核验 AI 相册识别是否支持纯本地离线运行，避免云端上传隐患。</li>
    </ul>
  </article>
</body>
</html>`);
        return;
      }
      if (pathname === '/anti-scrape/403') {
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" /><title>403 Forbidden</title></head><body><h1>403 Forbidden</h1><p>请求被反爬防火墙拦截，请稍后重试。</p></body></html>',
        );
        return;
      }
      if (pathname === '/anti-scrape/login-wall') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" /><title>访问受限</title></head><body><main><h1>访问受限</h1><p>当前内容仅对注册会员开放，请登录后查看完整评测正文。</p></main></body></html>',
        );
        return;
      }
      if (pathname === '/anti-scrape/slow-timeout') {
        const timer = setTimeout(() => {
          pendingTimers.delete(timer);
          if (!res.writableEnded && !res.destroyed) {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end('<!doctype html><html><body><p>slow response</p></body></html>');
          }
        }, 15_000);
        timer.unref?.();
        pendingTimers.add(timer);
        const cleanup = () => {
          if (pendingTimers.delete(timer)) {
            clearTimeout(timer);
          }
        };
        req.once('close', cleanup);
        res.once('close', cleanup);
        return;
      }
      if (pathname === '/articles/cnc-maintenance') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          buildFixtureArticleHtml(
            '数控钣金产线季度保养与精度复检作业规范',
            '数控钣金精密加工产线日常点检',
          ),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        buildFixtureArticleHtml(
          '中厚板光纤激光切割设备选型与工艺参数校核指南',
          '工业光纤激光切割装备选型',
        ),
      );
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  server.on('close', () => {
    for (const timer of pendingTimers) {
      clearTimeout(timer);
    }
    pendingTimers.clear();
  });

  const requestedPort = Number.parseInt(process.env.E2E_FIXTURE_PORT || '0', 10) || 0;
  await new Promise((resolve) => server.listen(requestedPort, '127.0.0.1', resolve));
  const address = server.address();
  return { server, port: address.port };
}

async function bootstrap() {
  loadRootEnv();
  if (!process.env.E2E_MEMORY_MAX_OBJECTS) {
    process.env.E2E_MEMORY_MAX_OBJECTS = '2000';
  }
  if (!process.env.IMAGE_PROVIDER) {
    process.env.IMAGE_PROVIDER = 'fake';
  }
  if (!process.env.CREDENTIAL_ENCRYPTION_KEY) {
    process.env.CREDENTIAL_ENCRYPTION_KEY =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  }
  if (
    (process.env.VISIBILITY_COLLECTOR || 'fake').trim().toLowerCase() === 'fake' &&
    process.env.VISIBILITY_DISABLED_ENGINES === undefined
  ) {
    process.env.VISIBILITY_DISABLED_ENGINES = 'yuanbao,tongyi,wenxin,nami,kimi,zhipu';
  }
  resetRobotsCache();
  const env = parseEnv();
  const fixtureHost = (process.env.E2E_PUBLIC_FIXTURE_HOST || 'public.e2e.example')
    .trim()
    .toLowerCase();

  let maintenanceRunner = null;
  const fixture = await startFixtureServer({
    getMaintenanceRunner: () => maintenanceRunner,
  });

  const VIRTUAL_HOSTS = new Set([fixtureHost, 'api.indexnow.org', 'api.webflow.com']);
  const isVirtualFixtureHost = (hostname) => {
    const h = String(hostname || '')
      .trim()
      .toLowerCase();
    return VIRTUAL_HOSTS.has(h) || h.endsWith('.e2e.example');
  };

  const realResolver = createDnsResolver();
  const realTransport = createUndiciTransport();

  const e2eResolver = {
    async resolve(hostname) {
      if (isVirtualFixtureHost(hostname)) {
        return [{ address: '93.184.216.34', family: 4 }];
      }
      return realResolver.resolve(hostname);
    },
  };
  const e2eTransport = (request) => {
    if (isVirtualFixtureHost(request.url.hostname)) {
      return forwardToLocalFixture(fixture.port, request);
    }
    return realTransport(request);
  };

  const e2ePublicFetch = (url, signal) =>
    fetchPublicPage(url, {
      timeoutMs: 8_000,
      maxBytes: 2_000_000,
      maxRedirects: 2,
      robotsCacheMs: 60_000,
      signal,
      resolver: e2eResolver,
      transport: e2eTransport,
    });

  // Patch ONLY resolver & transport for virtual public hosts; preserve PUBLIC_ONLY_ALLOWLIST
  // so 127.0.0.1, localhost, 10.x, 169.254.169.254, sonargate & SSRF redirects stay strictly blocked.
  const patchOutboundHttp = (app) => {
    const client = app.get(OutboundHttpClient);
    client.resolver = e2eResolver;
    client.transport = e2eTransport;
  };

  const apiApp = await createApiApp();
  apiApp.get(PublicFetchService).fetch = e2ePublicFetch;
  patchOutboundHttp(apiApp);

  const workerApp = await NestFactory.createApplicationContext(WorkerModule);
  workerApp.enableShutdownHooks();
  workerApp.get(PublicFetchService).fetch = e2ePublicFetch;
  patchOutboundHttp(workerApp);
  maintenanceRunner = workerApp.get(MaintenanceRunner, { strict: false });

  if ((process.env.STORAGE_DRIVER || 'memory').trim() === 'memory') {
    const sharedStorage = apiApp.get(StorageService);
    const workerStorage = workerApp.get(StorageService);
    workerStorage.put = sharedStorage.put.bind(sharedStorage);
    workerStorage.get = sharedStorage.get.bind(sharedStorage);
    workerStorage.delete = sharedStorage.delete.bind(sharedStorage);
  }

  await apiApp.listen(env.API_PORT);
  const workerStatus = workerApp.get(WorkerRuntimeService).status();
  Logger.log(
    `${SITE_NAME} E2E backend ready on :${env.API_PORT} (worker queue=${workerStatus.queue}, billing=${workerStatus.billingMode}, fixtureHost=${fixtureHost}->127.0.0.1:${fixture.port})`,
    'E2EBootstrap',
  );

  const shutdown = async () => {
    await workerApp.close().catch(() => undefined);
    await apiApp.close().catch(() => undefined);
    await new Promise((resolve) => {
      fixture.server.close(() => resolve());
      fixture.server.closeAllConnections?.();
    });
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[E2EBootstrap] fatal error:', err);
  process.exit(1);
});
