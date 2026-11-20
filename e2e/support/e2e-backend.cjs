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
const { StorageService } = require(path.join(serverDist, 'infra/storage.js'));

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

function forwardToLocalFixture(localPort, req) {
  return new Promise((resolve, reject) => {
    if (req.signal && req.signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const outgoing = http.request(
      {
        host: '127.0.0.1',
        port: localPort,
        method: req.method,
        path: `${req.url.pathname}${req.url.search}`,
        headers: {
          ...req.headers,
          host: req.url.host,
        },
      },
      (res) => {
        const chunks = [];
        let bytes = 0;
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > req.maxBytes) {
            outgoing.destroy(new Error('max_bytes'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const headers = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') headers[k] = v;
            else if (Array.isArray(v)) headers[k] = v.join(', ');
          }
          resolve({
            status: res.statusCode || 500,
            headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    const onAbort = () => outgoing.destroy(new Error('aborted'));
    if (req.signal) {
      req.signal.addEventListener('abort', onAbort, { once: true });
      outgoing.on('close', () => req.signal.removeEventListener('abort', onAbort));
    }
    outgoing.on('error', reject);
    outgoing.end();
  });
}

async function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const pathname = (req.url || '/').split('?')[0] || '/';
    if (pathname === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('User-agent: *\nAllow: /\n');
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
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { server, port: address.port };
}

async function bootstrap() {
  loadRootEnv();
  if (!process.env.E2E_MEMORY_MAX_OBJECTS) {
    process.env.E2E_MEMORY_MAX_OBJECTS = '2000';
  }
  resetRobotsCache();
  const env = parseEnv();
  const fixtureHost = (process.env.E2E_PUBLIC_FIXTURE_HOST || 'public.e2e.example')
    .trim()
    .toLowerCase();

  const fixture = await startFixtureServer();
  const realResolver = createDnsResolver();
  const realTransport = createUndiciTransport();

  const e2ePublicFetch = (url, signal) =>
    fetchPublicPage(url, {
      timeoutMs: 8_000,
      maxBytes: 2_000_000,
      maxRedirects: 2,
      robotsCacheMs: 60_000,
      signal,
      resolver: {
        async resolve(hostname) {
          if (hostname.toLowerCase() === fixtureHost) {
            return [{ address: '93.184.216.34', family: 4 }];
          }
          return realResolver.resolve(hostname);
        },
      },
      transport: (request) => {
        if (request.url.hostname.toLowerCase() === fixtureHost) {
          return forwardToLocalFixture(fixture.port, request);
        }
        return realTransport(request);
      },
    });

  const apiApp = await createApiApp();
  apiApp.get(PublicFetchService).fetch = e2ePublicFetch;

  const workerApp = await NestFactory.createApplicationContext(WorkerModule);
  workerApp.enableShutdownHooks();
  workerApp.get(PublicFetchService).fetch = e2ePublicFetch;

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
    await new Promise((resolve) => fixture.server.close(() => resolve()));
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
