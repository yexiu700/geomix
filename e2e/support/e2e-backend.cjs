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
