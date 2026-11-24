'use strict';

const crypto = require('node:crypto');

const V2_2_VIRTUAL_HOSTS = ['dev.to', 'gql.hashnode.com', 'api.github.com', 'api.weixin.qq.com'];

const V2_2_VIRTUAL_HOST_SET = new Set(V2_2_VIRTUAL_HOSTS);
const MYSHOPIFY_SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/;

const E2E_GHOST_KNOWN_KEYS = Object.freeze({
  e2e_ghost_key: '0123456789abcdef0123456789abcdef',
});

const DEFAULT_BASE_SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

// Stateful in-memory fixture stores (reset via resetV22FixtureState on DELETE /__e2e/captures)
const githubFiles = new Map();
const githubBranches = new Map();
const wechatTokens = new Map();
const shopifyOAuthTokens = new Map();
const shopifyWebhooks = new Map();
let fallbackSeq = 0;

function resetV22FixtureState() {
  githubFiles.clear();
  githubBranches.clear();
  wechatTokens.clear();
  shopifyOAuthTokens.clear();
  shopifyWebhooks.clear();
  fallbackSeq = 0;
}

function isMyShopifyHost(hostname) {
  const h = String(hostname || '')
    .trim()
    .toLowerCase();
  if (!h || h.length > 253) return false;
  return MYSHOPIFY_SUBDOMAIN_RE.test(h);
}

function isV22VirtualHost(hostname) {
  const h = String(hostname || '')
    .trim()
    .toLowerCase();
  if (!h) return false;
  return V2_2_VIRTUAL_HOST_SET.has(h) || isMyShopifyHost(h);
}

function verifyGhostJwt(authHeader, knownKeys = E2E_GHOST_KNOWN_KEYS) {
  const raw = String(authHeader || '').trim();
  if (!raw.startsWith('Ghost ')) {
    return { ok: false, kid: null, payload: null, error: 'Missing Ghost authorization scheme' };
  }
  const token = raw.slice('Ghost '.length).trim();
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !p)) {
    return { ok: false, kid: null, payload: null, error: 'Malformed Ghost JWT segments' };
  }
  const [headerB64, payloadB64, sigB64] = parts;

  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, kid: null, payload: null, error: 'Invalid base64url JSON in Ghost JWT' };
  }

  if (!header || typeof header !== 'object' || header.alg !== 'HS256') {
    return { ok: false, kid: null, payload: null, error: 'Ghost JWT alg must be HS256' };
  }
  const kid = typeof header.kid === 'string' ? header.kid.trim() : '';
  if (!kid) {
    return { ok: false, kid: null, payload: null, error: 'Ghost JWT kid is required' };
  }
  if (!payload || typeof payload !== 'object') {
    return { ok: false, kid, payload: null, error: 'Ghost JWT payload must be an object' };
  }

  const iat = payload.iat;
  const exp = payload.exp;
  if (
    typeof iat !== 'number' ||
    !Number.isFinite(iat) ||
    typeof exp !== 'number' ||
    !Number.isFinite(exp)
  ) {
    return { ok: false, kid, payload, error: 'Ghost JWT iat/exp must be finite numbers' };
  }
  if (exp <= iat) {
    return { ok: false, kid, payload, error: 'Ghost JWT exp must be greater than iat' };
  }
  if (exp - iat > 300) {
    return { ok: false, kid, payload, error: 'Ghost JWT TTL must not exceed 300 seconds' };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (exp <= nowSec - 15) {
    return { ok: false, kid, payload, error: 'Ghost JWT is expired' };
  }

  const aud = typeof payload.aud === 'string' ? payload.aud : '';
  if (!/^\/(?:v\d+\/)?admin\/$/.test(aud)) {
    return { ok: false, kid, payload, error: 'Ghost JWT aud must target /admin/' };
  }

  if (!/^[A-Za-z0-9_-]+$/.test(sigB64)) {
    return { ok: false, kid, payload, error: 'Ghost JWT signature is malformed' };
  }
  const actualSig = Buffer.from(sigB64, 'base64url');
  if (actualSig.length !== 32) {
    return { ok: false, kid, payload, error: 'Ghost JWT signature must be 32 bytes (HS256)' };
  }

  if (knownKeys && Object.prototype.hasOwnProperty.call(knownKeys, kid)) {
    const hexSecret = knownKeys[kid];
    const expectedSig = crypto
      .createHmac('sha256', Buffer.from(hexSecret, 'hex'))
      .update(`${headerB64}.${payloadB64}`)
      .digest();
    if (
      actualSig.length !== expectedSig.length ||
      !crypto.timingSafeEqual(actualSig, expectedSig)
    ) {
      return {
        ok: false,
        kid,
        payload,
        error: 'Ghost JWT HMAC-SHA256 signature verification failed',
      };
    }
  }

  return { ok: true, kid, payload, error: null };
}

function slugifyTitle(value, fallback) {
  const cleaned = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return cleaned || fallback;
}

function buildNearMissSparseHtml(canonicalUrl) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Overview Notes on Storage Hardware</title>
  <link rel="canonical" href="${canonicalUrl}" />
</head>
<body>
  <article>
    <h1>Overview Notes on Storage Hardware</h1>
    <p>This short overview mentions private cloud storage and quiet desktop enclosures in general terms.</p>
    <p>More engineering measurements and buyer guidance will be added in a future update.</p>
  </article>
</body>
</html>`;
}

function parseFormOrJsonBody(rawBody, parsedBody) {
  if (parsedBody && typeof parsedBody === 'object') {
    return parsedBody;
  }
  if (typeof rawBody === 'string' && rawBody.includes('=')) {
    const params = new URLSearchParams(rawBody);
    const out = {};
    for (const [k, v] of params.entries()) {
      out[k] = v;
    }
    return out;
  }
  return {};
}

function handleV22FixtureRequest(ctx) {
  const {
    req,
    res,
    parsedUrl,
    pathname,
    method,
    targetHost,
    targetProto,
    rawBody,
    parsedBody,
    nextSeq,
    recordCapture,
    sendJson,
    buildHealthyCrawlHtml,
  } = ctx;

  const allocSeq = () => {
    if (typeof nextSeq === 'function') return nextSeq();
    fallbackSeq += 1;
    return fallbackSeq;
  };

  // ── 1. Ghost Admin API v5 (`ghost.e2e.example`) ──
  if (targetHost === 'ghost.e2e.example') {
    if (pathname === '/robots.txt' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('User-agent: *\nAllow: /\n');
      return true;
    }
    if (pathname.startsWith('/ghost/api/admin/')) {
      const jwtCheck = verifyGhostJwt(req.headers.authorization, E2E_GHOST_KNOWN_KEYS);
      if (!jwtCheck.ok) {
        sendJson(res, 401, { errors: [{ message: jwtCheck.error || 'Invalid token' }] });
        return true;
      }
      const normPath = pathname.replace(/\/+$/, '');
      if (normPath === '/ghost/api/admin/site' && method === 'GET') {
        recordCapture('ghost_site', targetHost, req, `${pathname}${parsedUrl.search}`, rawBody, {
          ...(parsedBody && typeof parsedBody === 'object' ? parsedBody : {}),
          query: parsedUrl.search,
          jwtKid: jwtCheck.kid,
          jwtAud: jwtCheck.payload.aud,
        });
        sendJson(res, 200, {
          site: {
            title: 'E2E Ghost Blog',
            description: 'GeoMix E2E Ghost',
            url: 'https://ghost.e2e.example/',
            version: '5.90',
          },
        });
        return true;
      }
      if (normPath === '/ghost/api/admin/posts' && method === 'GET') {
        sendJson(res, 200, { posts: [] });
        return true;
      }
      if (normPath === '/ghost/api/admin/tags' && method === 'GET') {
        sendJson(res, 200, {
          tags: [{ id: 'tag_1', name: 'GEO', slug: 'geo' }],
        });
        return true;
      }
      if (normPath === '/ghost/api/admin/posts' && method === 'POST') {
        const post = Array.isArray(parsedBody?.posts) ? parsedBody.posts[0] : null;
        if (!post || typeof post.title !== 'string' || !post.title.trim()) {
          sendJson(res, 422, { errors: [{ message: 'Post title is required' }] });
          return true;
        }
        const s = allocSeq();
        const slug = slugifyTitle(post.slug || post.title, `ghost-post-${s}`);
        const status = String(post.status || 'draft');
        const enriched = {
          ...(parsedBody || {}),
          query: parsedUrl.search,
          source: parsedUrl.searchParams.get('source'),
          codeinjection_head: post.codeinjection_head || null,
          jwtKid: jwtCheck.kid,
          jwtAud: jwtCheck.payload.aud,
        };
        recordCapture(
          'ghost_post',
          targetHost,
          req,
          `${pathname}${parsedUrl.search}`,
          rawBody,
          enriched,
        );
        sendJson(res, 201, {
          posts: [
            {
              id: `ghost_post_${s}`,
              uuid: `uuid-${s}`,
              title: post.title,
              slug,
              status,
              url: `https://ghost.e2e.example/${encodeURIComponent(slug)}/`,
              html: String(post.html || ''),
              codeinjection_head: post.codeinjection_head || null,
            },
          ],
        });
        return true;
      }
      const putPostMatch = /^\/ghost\/api\/admin\/posts\/([^/]+)$/.exec(normPath);
      if (putPostMatch && method === 'PUT') {
        const post = Array.isArray(parsedBody?.posts) ? parsedBody.posts[0] : {};
        const s = allocSeq();
        const postId = putPostMatch[1];
        const slug = slugifyTitle(post?.slug || post?.title, `ghost-post-${s}`);
        const enriched = {
          ...(parsedBody || {}),
          query: parsedUrl.search,
          codeinjection_head: post?.codeinjection_head || null,
          jwtKid: jwtCheck.kid,
          jwtAud: jwtCheck.payload.aud,
        };
        recordCapture(
          'ghost_update',
          targetHost,
          req,
          `${pathname}${parsedUrl.search}`,
          rawBody,
          enriched,
        );
        sendJson(res, 200, {
          posts: [
            {
              id: postId,
              uuid: `uuid-${s}`,
              title: String(post?.title || 'Updated Ghost Post'),
              slug,
              status: String(post?.status || 'draft'),
              url: `https://ghost.e2e.example/${encodeURIComponent(slug)}/`,
              html: String(post?.html || ''),
              codeinjection_head: post?.codeinjection_head || null,
            },
          ],
        });
        return true;
      }
      sendJson(res, 404, { errors: [{ message: 'Ghost Admin endpoint not found' }] });
      return true;
    }
    const canonicalUrl = `${targetProto}://${targetHost}${pathname}`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(buildHealthyCrawlHtml(canonicalUrl));
    return true;
  }

  // ── 2. Dev.to / Forem REST API v1 (`dev.to` & `devto.e2e.example`) ──
  if (targetHost === 'dev.to' || targetHost === 'devto.e2e.example') {
    if (pathname === '/robots.txt' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('User-agent: *\nAllow: /\n');
      return true;
    }
    if (pathname.startsWith('/api/')) {
      const apiKey = String(req.headers['api-key'] || '').trim();
      if (!apiKey || apiKey === 'invalid-key') {
        sendJson(res, 401, { error: 'unauthorized', status: 401 });
        return true;
      }
      if (pathname === '/api/users/me' && method === 'GET') {
        recordCapture('devto_me', targetHost, req, pathname, rawBody, parsedBody);
        sendJson(res, 200, {
          type_of: 'user',
          id: 1001,
          username: 'geomix_e2e',
          name: 'GeoMix E2E Dev',
          website_url: 'https://dev.to/geomix_e2e',
        });
        return true;
      }
      if (pathname === '/api/articles' && method === 'POST') {
        const article = parsedBody?.article || {};
        recordCapture('devto_article', targetHost, req, pathname, rawBody, parsedBody);
        if (Array.isArray(article.tags) && article.tags.length > 4) {
          sendJson(res, 422, { error: 'Tags cannot exceed 4', status: 422 });
          return true;
        }
        const s = allocSeq();
        const title = String(article.title || `E2E Dev.to Article ${s}`);
        const slug = slugifyTitle(title, `devto-article-${s}`);
        sendJson(res, 201, {
          type_of: 'article',
          id: 5000 + s,
          title,
          description: String(article.description || ''),
          published: Boolean(article.published),
          slug,
          path: `/geomix_e2e/${slug}`,
          url: `https://dev.to/geomix_e2e/${slug}`,
          canonical_url: article.canonical_url || null,
          tag_list: Array.isArray(article.tags) ? article.tags : [],
        });
        return true;
      }
      const putArticleMatch = /^\/api\/articles\/([^/]+)$/.exec(pathname);
      if (putArticleMatch && method === 'PUT') {
        const article = parsedBody?.article || {};
        recordCapture('devto_article_update', targetHost, req, pathname, rawBody, parsedBody);
        if (Array.isArray(article.tags) && article.tags.length > 4) {
          sendJson(res, 422, { error: 'Tags cannot exceed 4', status: 422 });
          return true;
        }
        const s = allocSeq();
        const title = String(article.title || `E2E Dev.to Article ${s}`);
        const slug = slugifyTitle(title, `devto-article-${s}`);
        const parsedId = Number.parseInt(putArticleMatch[1], 10);
        sendJson(res, 200, {
          type_of: 'article',
          id: Number.isFinite(parsedId) ? parsedId : 5000 + s,
          title,
          description: String(article.description || ''),
          published: Boolean(article.published),
          slug,
          path: `/geomix_e2e/${slug}`,
          url: `https://dev.to/geomix_e2e/${slug}`,
          canonical_url: article.canonical_url || null,
          tag_list: Array.isArray(article.tags) ? article.tags : [],
        });
        return true;
      }
      sendJson(res, 404, { error: 'not found', status: 404 });
      return true;
    }
    const canonicalUrl = `${targetProto}://${targetHost}${pathname}`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(buildHealthyCrawlHtml(canonicalUrl));
    return true;
  }

  // ── 3. Hashnode GraphQL API (`gql.hashnode.com` & `hashnode.e2e.example`) ──
  if (targetHost === 'gql.hashnode.com' || targetHost === 'hashnode.e2e.example') {
    if (pathname === '/robots.txt' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('User-agent: *\nAllow: /\n');
      return true;
    }
    if (method === 'POST' && (pathname === '/' || pathname === '/graphql')) {
      const auth = String(req.headers.authorization || '').trim();
      if (!auth || auth.toLowerCase() === 'invalid' || auth.toLowerCase() === 'bearer invalid') {
        sendJson(res, 401, {
          errors: [{ message: 'Unauthenticated', extensions: { code: 'UNAUTHENTICATED' } }],
        });
        return true;
      }
      const query = typeof parsedBody?.query === 'string' ? parsedBody.query : '';
      const variables =
        parsedBody?.variables && typeof parsedBody.variables === 'object'
          ? parsedBody.variables
          : {};
      const input = variables.input && typeof variables.input === 'object' ? variables.input : {};

      if (query.includes('createDraft')) {
        const s = allocSeq();
        const title = String(input.title || `E2E Hashnode Draft ${s}`);
        const slug = slugifyTitle(input.slug || title, `hn-draft-${s}`);
        recordCapture('hashnode_create_draft', targetHost, req, pathname, rawBody, parsedBody);
        sendJson(res, 200, {
          data: {
            createDraft: {
              draft: {
                id: `hn_draft_${s}`,
                slug,
                title,
                canonicalUrl: input.originalArticleURL || null,
              },
            },
          },
        });
        return true;
      }
      if (query.includes('publishPost')) {
        const s = allocSeq();
        const title = String(input.title || `E2E Hashnode Post ${s}`);
        const slug = slugifyTitle(input.slug || title, `hn-post-${s}`);
        recordCapture('hashnode_publish_post', targetHost, req, pathname, rawBody, parsedBody);
        sendJson(res, 200, {
          data: {
            publishPost: {
              post: {
                id: `hn_post_${s}`,
                slug,
                title,
                url: `https://hashnode.e2e.example/${encodeURIComponent(slug)}`,
                canonicalUrl: input.originalArticleURL || null,
              },
            },
          },
        });
        return true;
      }

      recordCapture('hashnode_me', targetHost, req, pathname, rawBody, parsedBody);
      sendJson(res, 200, {
        data: {
          me: {
            id: 'hn_user_1',
            username: 'geomix_e2e',
            name: 'GeoMix E2E',
            publications: {
              edges: [
                {
                  node: {
                    id: 'hn_pub_1001',
                    title: 'GeoMix Engineering Blog',
                    url: 'https://hashnode.e2e.example',
                    domainInfo: { hashnodeSubdomain: 'geomix-e2e' },
                  },
                },
              ],
            },
          },
          publication: {
            id: 'hn_pub_1001',
            title: 'GeoMix Engineering Blog',
            url: 'https://hashnode.e2e.example',
          },
        },
      });
      return true;
    }
    const canonicalUrl = `${targetProto}://${targetHost}${pathname}`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(buildHealthyCrawlHtml(canonicalUrl));
    return true;
  }

  // ── 4. GitHub REST API v3 (`api.github.com` & `github.e2e.example`) ──
  if (targetHost === 'api.github.com' || targetHost === 'github.e2e.example') {
    if (pathname === '/robots.txt' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('User-agent: *\nAllow: /\n');
      return true;
    }
    const auth = String(req.headers.authorization || '').trim();
    const authMatch = /^(?:Bearer|token)\s+(.+)$/i.exec(auth);
    if (!authMatch || !authMatch[1].trim() || authMatch[1].trim() === 'invalid') {
      sendJson(res, 401, { message: 'Bad credentials' });
      return true;
    }

    if (pathname === '/user' && method === 'GET') {
      recordCapture('github_user', targetHost, req, pathname, rawBody, parsedBody);
      sendJson(res, 200, { id: 7001, login: 'geomix-bot', name: 'GeoMix Bot' });
      return true;
    }
    if (pathname === '/user/repos' && method === 'GET') {
      sendJson(res, 200, [
        {
          id: 8001,
          name: 'docs',
          full_name: 'geomix-bot/docs',
          default_branch: 'main',
          html_url: 'https://github.com/geomix-bot/docs',
        },
      ]);
      return true;
    }

    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)$/.exec(pathname);
    if (repoMatch && method === 'GET') {
      const [, owner, repo] = repoMatch;
      recordCapture('github_repo', targetHost, req, pathname, rawBody, parsedBody);
      sendJson(res, 200, {
        id: 8001,
        name: repo,
        full_name: `${owner}/${repo}`,
        default_branch: 'main',
        html_url: `https://github.com/${owner}/${repo}`,
        permissions: { push: true, pull: true },
      });
      return true;
    }

    const getRefMatch = /^\/repos\/([^/]+)\/([^/]+)\/git\/refs?\/heads\/(.+)$/.exec(pathname);
    if (getRefMatch && method === 'GET') {
      const [, owner, repo, branch] = getRefMatch;
      const sha = githubBranches.get(`${owner}/${repo}:${branch}`) || DEFAULT_BASE_SHA;
      sendJson(res, 200, {
        ref: `refs/heads/${branch}`,
        object: { sha, type: 'commit' },
      });
      return true;
    }

    const createRefMatch = /^\/repos\/([^/]+)\/([^/]+)\/git\/refs$/.exec(pathname);
    if (createRefMatch && method === 'POST') {
      const [, owner, repo] = createRefMatch;
      const refName = String(parsedBody?.ref || '');
      const sha = String(parsedBody?.sha || DEFAULT_BASE_SHA);
      const branch = refName.replace(/^refs\/heads\//, '');
      if (branch) {
        githubBranches.set(`${owner}/${repo}:${branch}`, sha);
      }
      recordCapture('github_create_ref', targetHost, req, pathname, rawBody, parsedBody);
      sendJson(res, 201, {
        ref: refName || `refs/heads/${branch}`,
        object: { sha, type: 'commit' },
      });
      return true;
    }

    const contentsMatch = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/.exec(pathname);
    if (contentsMatch && method === 'GET') {
      const [, owner, repo, filePath] = contentsMatch;
      const branch = parsedUrl.searchParams.get('ref') || 'main';
      const storeKey = `${owner}/${repo}@${branch}:${filePath}`;
      const existing = githubFiles.get(storeKey);
      if (!existing) {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      sendJson(res, 200, {
        sha: existing.sha,
        path: filePath,
        content: existing.content,
      });
      return true;
    }

    if (contentsMatch && method === 'PUT') {
      const [, owner, repo, filePath] = contentsMatch;
      const branch = String(parsedBody?.branch || 'main');
      const contentB64 = typeof parsedBody?.content === 'string' ? parsedBody.content : '';
      const decodedContent = contentB64 ? Buffer.from(contentB64, 'base64').toString('utf8') : '';
      const s = allocSeq();
      const fileSha = `file_sha_${s}`;
      const commitSha = `commit_sha_${s}`;
      const storeKey = `${owner}/${repo}@${branch}:${filePath}`;
      githubFiles.set(storeKey, { sha: fileSha, content: contentB64, decodedContent });
      const basename = filePath.split('/').pop() || filePath;

      recordCapture('github_put_contents', targetHost, req, pathname, rawBody, {
        ...(parsedBody && typeof parsedBody === 'object' ? parsedBody : {}),
        decodedContent,
      });
      sendJson(res, 201, {
        content: {
          name: basename,
          path: filePath,
          sha: fileSha,
          html_url: `https://github.com/${owner}/${repo}/blob/${encodeURIComponent(branch)}/${filePath}`,
        },
        commit: {
          sha: commitSha,
          html_url: `https://github.com/${owner}/${repo}/commit/${commitSha}`,
        },
      });
      return true;
    }

    const pullsMatch = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(pathname);
    if (pullsMatch && method === 'POST') {
      const [, owner, repo] = pullsMatch;
      const s = allocSeq();
      const prNumber = 40 + s;
      recordCapture('github_create_pr', targetHost, req, pathname, rawBody, parsedBody);
      sendJson(res, 201, {
        id: 9100 + s,
        number: prNumber,
        state: 'open',
        title: String(parsedBody?.title || 'GeoMix MDX Draft'),
        html_url: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
        head: { ref: String(parsedBody?.head || '') },
        base: { ref: String(parsedBody?.base || 'main') },
      });
      return true;
    }

    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  // ── 5. WeChat Official Draft API (`wechat.e2e.example`, `wechat-40164.e2e.example`, `api.weixin.qq.com`) ──
  if (
    targetHost === 'wechat.e2e.example' ||
    targetHost === 'wechat-40164.e2e.example' ||
    targetHost === 'api.weixin.qq.com'
  ) {
    // HARD RED LINE: Mass-send & free-publish endpoints MUST NEVER be called
    const rawReqPath = typeof req?.url === 'string' ? req.url.split(/[?#]/, 1)[0] : '';
    const wechatCandidatePaths = [pathname, rawReqPath]
      .filter(Boolean)
      .map((p) => p.toLowerCase().replace(/\/+/g, '/'));
    if (
      wechatCandidatePaths.some(
        (p) =>
          p === '/cgi-bin/freepublish' ||
          p.startsWith('/cgi-bin/freepublish/') ||
          p === '/cgi-bin/message/mass' ||
          p.startsWith('/cgi-bin/message/mass/'),
      )
    ) {
      recordCapture(
        'wechat_forbidden_mass_send',
        targetHost,
        req,
        rawReqPath || pathname,
        rawBody,
        parsedBody,
      );
      sendJson(res, 403, {
        errcode: 48001,
        errmsg: 'FORBIDDEN_BY_GEOMIX_REDLINE: mass-send API must never be called',
      });
      return true;
    }

    if (pathname === '/robots.txt' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('User-agent: *\nAllow: /\n');
      return true;
    }

    if (
      (pathname === '/cgi-bin/stable_token' && method === 'POST') ||
      (pathname === '/cgi-bin/token' && method === 'GET')
    ) {
      const appid =
        method === 'POST'
          ? String(parsedBody?.appid || '')
          : String(parsedUrl.searchParams.get('appid') || '');
      const secret =
        method === 'POST'
          ? String(parsedBody?.secret || '')
          : String(parsedUrl.searchParams.get('secret') || '');

      recordCapture('wechat_token', targetHost, req, `${pathname}${parsedUrl.search}`, rawBody, {
        ...(parsedBody && typeof parsedBody === 'object' ? parsedBody : {}),
        appid,
      });

      if (
        targetHost === 'wechat-40164.e2e.example' ||
        appid.includes('40164') ||
        secret.includes('40164')
      ) {
        sendJson(res, 200, {
          errcode: 40164,
          errmsg:
            'invalid ip 203.0.113.10 ipv6 ::ffff:203.0.113.10, not in whitelist rid: e2e-40164',
        });
        return true;
      }
      if (!appid || !secret || appid === 'invalid' || secret === 'invalid') {
        sendJson(res, 200, { errcode: 40013, errmsg: 'invalid appid' });
        return true;
      }
      const s = allocSeq();
      const accessToken = `wx_e2e_token_${s}`;
      wechatTokens.set(accessToken, { appid, createdAt: Date.now() });
      sendJson(res, 200, { access_token: accessToken, expires_in: 7200 });
      return true;
    }

    const accessToken = String(parsedUrl.searchParams.get('access_token') || '').trim();
    const requireWeChatToken = () => {
      if (!accessToken || accessToken === 'invalid') {
        sendJson(res, 200, {
          errcode: 40001,
          errmsg: 'invalid credential, access_token is invalid or not latest',
        });
        return false;
      }
      return true;
    };

    if (pathname === '/cgi-bin/material/add_material' && method === 'POST') {
      if (!requireWeChatToken()) return true;
      const s = allocSeq();
      recordCapture(
        'wechat_add_material',
        targetHost,
        req,
        `${pathname}${parsedUrl.search}`,
        rawBody,
        parsedBody,
      );
      sendJson(res, 200, {
        media_id: `wx_thumb_media_${s}`,
        url: `https://wechat.e2e.example/mmbiz/thumb_${s}.jpg`,
      });
      return true;
    }

    if (pathname === '/cgi-bin/media/uploadimg' && method === 'POST') {
      if (!requireWeChatToken()) return true;
      const s = allocSeq();
      recordCapture(
        'wechat_uploadimg',
        targetHost,
        req,
        `${pathname}${parsedUrl.search}`,
        rawBody,
        parsedBody,
      );
      sendJson(res, 200, {
        url: `https://wechat.e2e.example/mmbiz/inline_${s}.jpg`,
      });
      return true;
    }

    if (pathname === '/cgi-bin/draft/add' && method === 'POST') {
      if (!requireWeChatToken()) return true;
      const articles = Array.isArray(parsedBody?.articles) ? parsedBody.articles : [];
      if (articles.length === 0 || !articles[0]) {
        sendJson(res, 200, { errcode: 45009, errmsg: 'articles must contain at least one item' });
        return true;
      }
      const s = allocSeq();
      recordCapture(
        'wechat_draft_add',
        targetHost,
        req,
        `${pathname}${parsedUrl.search}`,
        rawBody,
        parsedBody,
      );
      sendJson(res, 200, { media_id: `wx_draft_media_${s}` });
      return true;
    }

    if (pathname === '/cgi-bin/draft/count' && method === 'GET') {
      if (!requireWeChatToken()) return true;
      recordCapture(
        'wechat_draft_count',
        targetHost,
        req,
        `${pathname}${parsedUrl.search}`,
        rawBody,
        parsedBody,
      );
      sendJson(res, 200, { total_count: 3 });
      return true;
    }

    const canonicalUrl = `${targetProto}://${targetHost}${pathname}`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(buildHealthyCrawlHtml(canonicalUrl));
    return true;
  }

  // ── 6. Shopify OAuth 2.0 & Admin REST/GraphQL (`*.myshopify.com`) ──
  if (isMyShopifyHost(targetHost)) {
    if (pathname === '/robots.txt' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('User-agent: *\nAllow: /\n');
      return true;
    }

    if (pathname === '/admin/oauth/access_token' && method === 'POST') {
      const bodyObj = parseFormOrJsonBody(rawBody, parsedBody);
      recordCapture('shopify_oauth_token', targetHost, req, pathname, rawBody, bodyObj);
      const clientId = String(bodyObj.client_id || '').trim();
      const clientSecret = String(bodyObj.client_secret || '').trim();
      const code = String(bodyObj.code || '').trim();
      if (!clientId || !clientSecret || !code || code === 'bad-code') {
        sendJson(res, 400, { error: 'invalid_request' });
        return true;
      }
      const s = allocSeq();
      const accessToken = `shpat_e2e_oauth_${s}`;
      if (!shopifyOAuthTokens.has(targetHost)) {
        shopifyOAuthTokens.set(targetHost, new Set());
      }
      shopifyOAuthTokens.get(targetHost).add(accessToken);
      sendJson(res, 200, {
        access_token: accessToken,
        scope: 'read_content,write_content',
      });
      return true;
    }

    if (/^\/admin\/api\/[^/]+\//i.test(pathname)) {
      const accessToken = String(req.headers['x-shopify-access-token'] || '').trim();
      if (!accessToken || accessToken.toLowerCase() === 'invalid') {
        sendJson(res, 401, { errors: 'Unauthorized' });
        return true;
      }

      if (method === 'POST' && /^\/admin\/api\/[^/]+\/webhooks\.json$/i.test(pathname)) {
        const s = allocSeq();
        const topic = String(parsedBody?.webhook?.topic || 'app/uninstalled');
        const address = String(parsedBody?.webhook?.address || '');
        const format = String(parsedBody?.webhook?.format || 'json');
        const webhook = { id: 7700 + s, topic, address, format };
        if (!shopifyWebhooks.has(targetHost)) {
          shopifyWebhooks.set(targetHost, []);
        }
        shopifyWebhooks.get(targetHost).push(webhook);
        recordCapture('shopify_webhook_register', targetHost, req, pathname, rawBody, parsedBody);
        sendJson(res, 201, { webhook });
        return true;
      }

      if (method === 'GET' && /^\/admin\/api\/[^/]+\/shop\.json$/i.test(pathname)) {
        recordCapture('shopify_shop', targetHost, req, pathname, rawBody, parsedBody);
        sendJson(res, 200, {
          shop: {
            id: 1,
            name: 'E2E OAuth Store',
            domain: targetHost,
            myshopify_domain: targetHost,
          },
        });
        return true;
      }

      if (method === 'GET' && /^\/admin\/api\/[^/]+\/blogs\.json$/i.test(pathname)) {
        recordCapture('shopify_blogs', targetHost, req, pathname, rawBody, parsedBody);
        sendJson(res, 200, {
          blogs: [{ id: 1001, title: 'Insights', handle: 'news' }],
        });
        return true;
      }

      if (method === 'POST' && /^\/admin\/api\/[^/]+\/graphql\.json$/i.test(pathname)) {
        const query = typeof parsedBody?.query === 'string' ? parsedBody.query : '';
        if (query.includes('webhookSubscriptionCreate')) {
          const s = allocSeq();
          recordCapture('shopify_webhook_register', targetHost, req, pathname, rawBody, parsedBody);
          sendJson(res, 200, {
            data: {
              webhookSubscriptionCreate: {
                webhookSubscription: {
                  id: `gid://shopify/WebhookSubscription/${7700 + s}`,
                },
                userErrors: [],
              },
            },
          });
          return true;
        }
        if (query.includes('articleCreate')) {
          const s = allocSeq();
          const art = parsedBody?.variables?.article || {};
          const handle = String(art.handle || `e2e-shopify-oauth-${s}`);
          recordCapture('shopify_oauth_article', targetHost, req, pathname, rawBody, parsedBody);
          sendJson(res, 200, {
            data: {
              articleCreate: {
                article: {
                  id: `gid://shopify/Article/900${s}`,
                  handle,
                  title: String(art.title || 'E2E Shopify OAuth Article'),
                  isPublished: Boolean(art.isPublished),
                  blog: {
                    id: String(art.blogId || 'gid://shopify/Blog/1001'),
                    handle: 'news',
                  },
                },
                userErrors: [],
              },
            },
          });
          return true;
        }
        recordCapture('shopify_shop', targetHost, req, pathname, rawBody, parsedBody);
        sendJson(res, 200, {
          data: {
            shop: {
              name: 'E2E OAuth Store',
              primaryDomain: { url: `https://${targetHost}` },
            },
            blogs: {
              nodes: [{ id: 'gid://shopify/Blog/1001', title: 'Insights', handle: 'news' }],
            },
          },
        });
        return true;
      }

      sendJson(res, 404, { errors: 'Not Found' });
      return true;
    }

    const canonicalUrl = `${targetProto}://${targetHost}${pathname}`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(buildHealthyCrawlHtml(canonicalUrl));
    return true;
  }

  // ── 7. Near-Miss Sparse Target (`near-miss.e2e.example`) ──
  if (targetHost === 'near-miss.e2e.example') {
    if (pathname === '/robots.txt' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('User-agent: *\nAllow: /\n');
      return true;
    }
    const canonicalUrl = `${targetProto}://${targetHost}${pathname}`;
    recordCapture('near_miss_page', targetHost, req, pathname, rawBody, parsedBody);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(buildNearMissSparseHtml(canonicalUrl));
    return true;
  }

  return false;
}

module.exports = {
  V2_2_VIRTUAL_HOSTS,
  E2E_GHOST_KNOWN_KEYS,
  isV22VirtualHost,
  verifyGhostJwt,
  resetV22FixtureState,
  handleV22FixtureRequest,
};
