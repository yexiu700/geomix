import 'reflect-metadata';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import {
  AUTH_ERROR,
  resolveFetchSettings,
  rewriteSingleCreateSchema,
  type ArticleDetailRecord,
  type RewriteRecordItem,
  type RewriteRecordListResponse,
  type RewriteSingleCreateResponse,
  type RewriteUrlCheckResponse,
} from '@geomix/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BillingService } from '../billing/billing.service';
import { createApiApp } from '../common/create-api-app';
import { createIsolatedTestContext, httpCall, type IsolatedTestContext } from '../common/test-db';
import { PublicFetchService } from '../infra/adapters.module';
import type { TransportRequest, TransportResponse } from '../infra/guarded-request';
import { LlmService, type LlmCallResult, type LlmCompleteInput } from '../infra/llm';
import { resetRobotsCache } from '../infra/public-fetch';

const FIXTURE_WECHAT = `<!doctype html>
<html>
<head><title>工业传感器选型实务</title></head>
<body>
  <h1 id="activity-name">工业传感器选型实务：从工况评估到维护核对</h1>
  <div id="js_content">
    <p>在自动化产线升级改造过程中，传感器选型直接决定采集信号的稳定性与后续巡检的工作量。许多现场工程师只看量程上限，却忽略了环境温湿度波动、电磁干扰以及安装空间限制，导致投产三个月后频繁出现零点漂移。</p>
    <p><img src="https://mmbiz.qpic.cn/sz_mmbiz_jpg/orig-wx-photo/640" alt="公众号原图" /></p>
    <p>第一步需要核对被测介质的物理特性与工作温度区间。高温蒸汽或强腐蚀性液体场景下，探头密封材质和引线护套耐温等级必须留出充足安全裕量，切忌贴着极限参数长期满负荷运行。</p>
    <p>第二步是确认输出信号制式与现场控制柜接口是否兼容。模拟量电流信号抗干扰能力较强，适合长距离敷设；数字总线接口则便于多节点集中诊断与参数远程下发。</p>
    <p>第三步还要把日常标定周期、备件通用性和故障替换耗时纳入综合测算，通过两周小批量试运行记录真实波动曲线。</p>
    <p>扫码关注公众号领取电子版表格</p>
  </div>
  <div id="js_pc_qr_code"><img src="https://mmbiz.qpic.cn/qr.png" />长按识别二维码</div>
</body>
</html>`;

const FIXTURE_ZHIHU = `<!doctype html>
<html>
<head><title>中小企业知识库搭建避坑记录 - 知乎</title></head>
<body>
  <article class="Post-Main">
    <h1 class="Post-Title">中小企业知识库搭建避坑记录</h1>
    <div class="Post-RichTextContainer">
      <p>不少团队在启动内部知识库整理时，上来就要求所有部门把过去五年的历史文档一次性全部上传，结果目录层级混乱、版本互相冲突，检索出来的答案半数已经过期失效。</p>
      <figure><img src="https://picx.zhimg.com/v2-orig-zhihu.jpg" /><figcaption>原图说明</figcaption></figure>
      <h2>先高频问题后历史归档</h2>
      <p>更稳妥的做法是从一线客服与销售每周被反复追问的三十个高频问题切入，先由业务负责人核对标准口径、适用范围和例外边界，整理成结构化问答卡片并标注更新时间。</p>
      <p>同时建立月度巡检机制：凡是涉及产品参数变更、流程调整或价格体系更新的条目，必须在变更生效当天同步修订旧文档，避免新老员工看到截然不同的执行说明。</p>
    </div>
  </article>
</body>
</html>`;

const FIXTURE_GENERIC = `<!doctype html>
<html>
<head><title>冷链仓储温控巡检规范解读 _ 物流技术参考网</title></head>
<body>
  <aside class="sidebar"><a href="/a">侧栏广告</a></aside>
  <div class="article-content" id="artibody">
    <h1>冷链仓储温控巡检规范解读</h1>
    <p>生鲜与医药冷链仓储的核心难点不在于制冷机组本身，而在于库门开启装卸货期间的局部温度回升控制，以及死角测温探头的布点合理性。</p>
    <picture><img src="https://cdn.example.org/orig-coldchain.jpg" alt="门户原图" /></picture>
    <p>按照分区分级管理经验，收发货月台缓冲间、货架顶层回风口以及靠近库门两侧通道都应当设置独立测点，采样间隔控制在五分钟以内，并配置多级越限告警阈值。</p>
    <p>一旦出现探头读数持续偏离设定区间，值班人员需要按照先核查库门密封条与风幕机运行状态、再排查化霜周期与冷媒压力的顺序逐项定位并留存处置工单。</p>
  </div>
</body>
</html>`;

const FIXTURE_SHORT = `<!doctype html>
<html>
<head><title>行业短讯</title></head>
<body>
  <article>
    <h1>简短展会快讯</h1>
    <p>今日某工业设备展在本地展馆开幕，现场设三个展区，预计展期三天。</p>
  </article>
</body>
</html>`;

function forwardToLocalFixture(
  localPort: number,
  req: TransportRequest,
): Promise<TransportResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
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
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > req.maxBytes) {
            outgoing.destroy(new Error('max_bytes'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') headers[k] = v;
            else if (Array.isArray(v)) headers[k] = v.join(', ');
          }
          resolve({
            status: res.statusCode ?? 500,
            headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end(req.body);
  });
}

describe('rewrites routes without a database', () => {
  let app: INestApplication;
  let base = '';

  beforeAll(async () => {
    app = await createApiApp();
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('validates rewriteSingleCreateSchema with 0 images without gallery and requires gallery when imageCount > 0', () => {
    const noImageParsed = rewriteSingleCreateSchema.safeParse({
      url: 'https://news.example.org/a',
      mediaCategoryId: null,
      imageCount: 0,
      templateId: 'sys_rewrite_01',
    });
    expect(noImageParsed.success).toBe(true);
    if (noImageParsed.success) {
      expect(noImageParsed.data.mediaCategoryId).toBeNull();
      expect(noImageParsed.data.imageCount).toBe(0);
    }

    const withImagesNoGallery = rewriteSingleCreateSchema.safeParse({
      url: 'https://news.example.org/a',
      mediaCategoryId: null,
      imageCount: 2,
      templateId: 'sys_rewrite_01',
    });
    expect(withImagesNoGallery.success).toBe(false);
  });

  it('rejects anonymous list, check-url, and create requests', async () => {
    const listRes = await httpCall(base, 'GET', '/api/v1/rewrites');
    expect(listRes.status).toBe(401);
    expect(listRes.code).toBe(AUTH_ERROR.UNAUTHORIZED);

    const checkRes = await httpCall(
      base,
      'GET',
      '/api/v1/rewrites/check-url?url=https://news.example.org/a',
    );
    expect(checkRes.status).toBe(401);

    const postRes = await httpCall(base, 'POST', '/api/v1/rewrites', {
      body: {
        url: 'https://news.example.org/a',
        mediaCategoryId: 'mcat_1',
        imageCount: 2,
        templateId: 'sys_rewrite_01',
      },
    });
    expect(postRes.status).toBe(401);
  });
});

describe.skipIf(process.env.GEOMIX_DB_INTEGRATION !== '1')(
  'single-article rewrite pipeline: 3 local HTML fixtures, SSRF block, point refund, gallery images only, 5-gram similarity retry, and AI_WRITE quota invariance',
  () => {
    let fixtureServer: Server;
    let fixturePort = 0;
    let ctx: IsolatedTestContext;
    let forceVerbatimLlm = false;
    let llmCallCounter = 0;

    beforeAll(async () => {
      resetRobotsCache();
      fixtureServer = createServer((req, res) => {
        const pathname = (req.url ?? '/').split('?')[0];
        if (pathname === '/robots.txt') {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('User-agent: *\nAllow: /\n');
          return;
        }
        if (pathname === '/wechat-sensor') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(FIXTURE_WECHAT);
          return;
        }
        if (pathname === '/zhihu-kb') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(FIXTURE_ZHIHU);
          return;
        }
        if (pathname === '/portal-coldchain') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(FIXTURE_GENERIC);
          return;
        }
        if (pathname === '/short-news') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(FIXTURE_SHORT);
          return;
        }
        if (pathname === '/login-wall') {
          res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body>请登录后查看</body></html>');
          return;
        }
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body>not found</body></html>');
      });

      await new Promise<void>((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
      fixturePort = (fixtureServer.address() as AddressInfo).port;

      const baseLlm = LlmService.fromEnv({});
      const testLlm = {
        async complete(input: LlmCompleteInput): Promise<LlmCallResult> {
          llmCallCounter += 1;
          const base = await baseLlm.complete(input);
          if (forceVerbatimLlm) {
            return {
              ...base,
              text: [
                '冷链仓储温控巡检规范复刻稿',
                '',
                '## 温控巡检核心难点',
                '生鲜与医药冷链仓储的核心难点不在于制冷机组本身，而在于库门开启装卸货期间的局部温度回升控制，以及死角测温探头的布点合理性。',
                '按照分区分级管理经验，收发货月台缓冲间、货架顶层回风口以及靠近库门两侧通道都应当设置独立测点，采样间隔控制在五分钟以内，并配置多级越限告警阈值。',
                '一旦出现探头读数持续偏离设定区间，值班人员需要按照先核查库门密封条与风幕机运行状态、再排查化霜周期与冷媒压力的顺序逐项定位并留存处置工单。',
              ].join('\n'),
              provider: 'fake',
              model: 'fake-verbatim',
              fake: false,
            };
          }
          return base;
        },
      };

      const testPublicFetch = new PublicFetchService({
        ...resolveFetchSettings(process.env),
        resolver: {
          async resolve(hostname: string) {
            if (hostname === 'intranet.corp.example') {
              return [{ address: '10.0.0.8', family: 4 as const }];
            }
            return [{ address: '93.184.216.34', family: 4 as const }];
          },
        },
        transport: (req) => forwardToLocalFixture(fixturePort, req),
      });

      ctx = await createIsolatedTestContext('rws', async (buildApp) => {
        const nestApp = await buildApp();
        const fetchSvc = nestApp.get(PublicFetchService);
        fetchSvc.fetch = (url: string, signal?: AbortSignal) => testPublicFetch.fetch(url, signal);
        const llmSvc = nestApp.get(LlmService);
        llmSvc.complete = (input: LlmCompleteInput) => testLlm.complete(input);
        return nestApp;
      });
    }, 120_000);

    afterAll(async () => {
      if (ctx) await ctx.close();
      if (fixtureServer) {
        await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
      }
    }, 60_000);

    it('rewrites WeChat, Zhihu, and Generic HTML fixtures with gallery images only, blocks SSRF & short pages with full point refund, supports pastedText & high-similarity retry, and leaves AI_WRITE quota untouched', async () => {
      const merchant = await ctx.createTenantUser({
        prefix: 'rwm',
        points: 100,
        billingMode: 'STRICT',
      });
      const billing = ctx.app.get(BillingService);

      // Prepare tenant gallery category + 3 uploaded gallery images
      const mediaCat = await ctx.prisma.base.mediaCategory.create({
        data: { tenantId: merchant.tenantId, name: '复刻专属图库', type: 1 },
      });
      const galleryUrls = [
        '/uploads/gallery-own-1.jpg',
        '/uploads/gallery-own-2.jpg',
        '/uploads/gallery-own-3.jpg',
      ];
      for (let idx = 0; idx < galleryUrls.length; idx += 1) {
        await ctx.prisma.base.mediaAsset.create({
          data: {
            id: `med_rw_${idx + 1}_${Date.now()}`,
            tenantId: merchant.tenantId,
            categoryId: mediaCat.id,
            origin: 'UPLOAD',
            objectKey: `rw/own-${idx + 1}.jpg`,
            url: galleryUrls[idx]!,
            thumbUrl: galleryUrls[idx]!,
            width: 900,
            height: 600,
            bytes: 15_000,
            mime: 'image/jpeg',
            usedCount: 0,
          },
        });
      }

      const customCat = await ctx.prisma.base.articleCategory.create({
        data: { tenantId: merchant.tenantId, name: '行业精选复刻' },
      });

      // 1. Reject non-REWRITE template (e.g. sys_article_01)
      const wrongTplRes = await httpCall(ctx.base, 'POST', '/api/v1/rewrites', {
        token: merchant.token,
        body: {
          url: 'https://mp.weixin.qq.com/wechat-sensor',
          mediaCategoryId: mediaCat.id,
          imageCount: 2,
          templateId: 'sys_article_01',
        },
      });
      expect(wrongTplRes.status).toBe(400);

      // 2. Fixture #1: WeChat Official Account -> explicit category + PENDING status + 2 gallery images
      const wxRes = await httpCall<RewriteSingleCreateResponse>(
        ctx.base,
        'POST',
        '/api/v1/rewrites',
        {
          token: merchant.token,
          body: {
            url: 'https://mp.weixin.qq.com/wechat-sensor',
            mediaCategoryId: mediaCat.id,
            imageCount: 2,
            templateId: 'sys_rewrite_01',
            categoryId: customCat.id,
            resultStatus: 'PENDING',
            brand: '精测传感',
          },
        },
      );
      expect(wxRes.status).toBe(200);
      expect(wxRes.data.settledPoints).toBe(5);
      expect(wxRes.data.record.status).toBe('SUCCESS');
      expect(wxRes.data.record.sourceTitle).toBe('工业传感器选型实务：从工况评估到维护核对');
      expect(wxRes.data.record.articleStatus).toBe('PENDING');
      expect(wxRes.data.record.categoryId).toBe(customCat.id);

      const wxArticle = await httpCall<ArticleDetailRecord>(
        ctx.base,
        'GET',
        `/api/v1/articles/${wxRes.data.record.articleId}`,
        { token: merchant.token },
      );
      expect(wxArticle.status).toBe(200);
      expect(wxArticle.data.source).toBe('REWRITE_SINGLE');
      expect(wxArticle.data.contentHtml).not.toContain('mmbiz.qpic.cn');
      expect(wxArticle.data.contentHtml).toContain('/uploads/gallery-own-');
      expect((wxArticle.data.contentHtml.match(/<img\b/gi) ?? []).length).toBe(2);

      // Duplicate 24h URL check returns warning
      const dupCheck = await httpCall<RewriteUrlCheckResponse>(
        ctx.base,
        'GET',
        `/api/v1/rewrites/check-url?url=${encodeURIComponent('https://mp.weixin.qq.com/wechat-sensor?utm_source=share')}`,
        { token: merchant.token },
      );
      expect(dupCheck.status).toBe(200);
      expect(dupCheck.data.duplicateRecent).toBe(true);
      expect(dupCheck.data.warning).toContain('24 小时内');

      // 3. Fixture #2: Zhihu Column -> editable timestamped autoCategoryName + NORMAL status + 3 gallery images
      const zhRes = await httpCall<RewriteSingleCreateResponse>(
        ctx.base,
        'POST',
        '/api/v1/rewrites',
        {
          token: merchant.token,
          body: {
            url: 'https://zhuanlan.zhihu.com/zhihu-kb',
            mediaCategoryId: mediaCat.id,
            imageCount: 3,
            templateId: 'sys_rewrite_01',
            autoCategoryName: '爆文复刻-20261117-知乎批次',
            resultStatus: 'NORMAL',
          },
        },
      );
      expect(zhRes.status).toBe(200);
      expect(zhRes.data.record.sourceTitle).toBe('中小企业知识库搭建避坑记录');
      expect(zhRes.data.record.categoryName).toBe('爆文复刻-20261117-知乎批次');
      expect(zhRes.data.record.articleStatus).toBe('NORMAL');

      const zhArticle = await httpCall<ArticleDetailRecord>(
        ctx.base,
        'GET',
        `/api/v1/articles/${zhRes.data.record.articleId}`,
        { token: merchant.token },
      );
      expect(zhArticle.data.contentHtml).not.toContain('picx.zhimg.com');
      expect((zhArticle.data.contentHtml.match(/<img\b/gi) ?? []).length).toBe(3);

      // 4. Fixture #3: Generic Portal -> ALSO test high 5-gram similarity retry + yellow warning flag!
      forceVerbatimLlm = true;
      const callsBeforeHighSim = llmCallCounter;
      const genRes = await httpCall<RewriteSingleCreateResponse>(
        ctx.base,
        'POST',
        '/api/v1/rewrites',
        {
          token: merchant.token,
          body: {
            url: 'https://news.example.org/portal-coldchain',
            mediaCategoryId: mediaCat.id,
            imageCount: 1,
            templateId: 'sys_rewrite_01',
            categoryId: customCat.id,
          },
        },
      );
      forceVerbatimLlm = false;
      expect(genRes.status).toBe(200);
      // Should have retried once (2 LLM calls total) and marked highSimilarity: true without blocking!
      expect(llmCallCounter - callsBeforeHighSim).toBe(2);
      expect(genRes.data.record.sourceTitle).toBe('冷链仓储温控巡检规范解读');
      expect(genRes.data.record.highSimilarity).toBe(true);
      expect(genRes.data.record.similarity).toBeGreaterThan(0.35);

      const genArticle = await httpCall<ArticleDetailRecord>(
        ctx.base,
        'GET',
        `/api/v1/articles/${genRes.data.record.articleId}`,
        { token: merchant.token },
      );
      expect(genArticle.data.contentHtml).not.toContain('cdn.example.org');
      expect((genArticle.data.contentHtml.match(/<img\b/gi) ?? []).length).toBe(1);

      // Wallet after 3 successful rewrites: 100 - 15 = 85 points, 0 reserved
      const walletAfter3 = await billing.wallet(merchant.tenantId);
      expect(walletAfter3.points).toBe(85);
      expect(walletAfter3.pointsReserved).toBe(0);

      // 5. SSRF internal address interception + full point refund
      for (const badInternalUrl of [
        `http://127.0.0.1:${fixturePort}/portal-coldchain`,
        'http://169.254.169.254/latest/meta-data/',
        'http://internal.corp.local/portal-coldchain',
        'http://intranet.corp.example/portal-coldchain',
        'https://news.example.org:8443/portal-coldchain',
      ]) {
        const ssrfRes = await httpCall(ctx.base, 'POST', '/api/v1/rewrites', {
          token: merchant.token,
          body: {
            url: badInternalUrl,
            mediaCategoryId: mediaCat.id,
            imageCount: 1,
            templateId: 'sys_rewrite_01',
          },
        });
        expect(ssrfRes.status).toBe(400);
        expect(ssrfRes.msg).toContain('不允许访问');
      }

      const walletAfterSsrf = await billing.wallet(merchant.tenantId);
      expect(walletAfterSsrf.points).toBe(85);
      expect(walletAfterSsrf.pointsReserved).toBe(0);

      // 6. Short source (< 200 chars) & login-wall (403) rejected with full refund
      const shortRes = await httpCall(ctx.base, 'POST', '/api/v1/rewrites', {
        token: merchant.token,
        body: {
          url: 'https://news.example.org/short-news',
          mediaCategoryId: mediaCat.id,
          imageCount: 2,
          templateId: 'sys_rewrite_01',
        },
      });
      expect(shortRes.status).toBe(422);
      expect(shortRes.msg).toContain('200');

      const loginWallRes = await httpCall(ctx.base, 'POST', '/api/v1/rewrites', {
        token: merchant.token,
        body: {
          url: 'https://news.example.org/login-wall',
          mediaCategoryId: mediaCat.id,
          imageCount: 2,
          templateId: 'sys_rewrite_01',
        },
      });
      expect(loginWallRes.status).toBe(422);
      expect(loginWallRes.msg).toContain('粘贴原文');

      const walletAfterFailures = await billing.wallet(merchant.tenantId);
      expect(walletAfterFailures.points).toBe(85);
      expect(walletAfterFailures.pointsReserved).toBe(0);

      // 7. Pasted-text fallback succeeds and settles 5 points (85 -> 80)
      const pasteRes = await httpCall<RewriteSingleCreateResponse>(
        ctx.base,
        'POST',
        '/api/v1/rewrites',
        {
          token: merchant.token,
          body: {
            pastedText: true,
            url: 'https://news.example.org/login-wall',
            pastedTitle: '手工粘贴：车间压缩空气管路节能巡检方法',
            pastedContent:
              '压缩空气系统在制造工厂能耗构成中占比显著，常见损耗来自法兰接头微漏、排水阀卡阻常开以及末端调压阀设定偏高。建议每周停机时段采用超声波检漏仪沿主管路与支线快换接头逐段排查，分级张贴标签并在四十八小时内完成密封件更换；同时根据气动执行器实际最低工作压力下调支路减压阀，避免无谓的高压排气损耗。'.repeat(
                2,
              ),
            mediaCategoryId: mediaCat.id,
            imageCount: 2,
            templateId: 'sys_rewrite_01',
            categoryId: customCat.id,
            resultStatus: 'PENDING',
          },
        },
      );
      expect(pasteRes.status).toBe(200);
      expect(pasteRes.data.record.pastedText).toBe(true);
      expect(pasteRes.data.record.status).toBe('SUCCESS');

      const walletFinal = await billing.wallet(merchant.tenantId);
      expect(walletFinal.points).toBe(80);
      expect(walletFinal.pointsReserved).toBe(0);
      expect(await billing.auditTenant(merchant.tenantId)).toEqual([]);

      // 8. Verify AI_WRITE quota is STILL 0 (复刻成功不计入「AI写作数量」)
      const aiWriteQuota = await ctx.prisma.base.quota.findUniqueOrThrow({
        where: { tenantId_key: { tenantId: merchant.tenantId, key: 'AI_WRITE' } },
      });
      expect(Number(aiWriteQuota.used)).toBe(0);

      // 9. Bulk update linked article status + list + CSV export + delete
      const bulkRes = await httpCall<{ affected: number }>(
        ctx.base,
        'POST',
        '/api/v1/rewrites/bulk-status',
        {
          token: merchant.token,
          body: {
            ids: [wxRes.data.record.id, pasteRes.data.record.id],
            status: 'NORMAL',
          },
        },
      );
      expect(bulkRes.status).toBe(200);
      expect(bulkRes.data.affected).toBe(2);

      const listRes = await httpCall<RewriteRecordListResponse>(
        ctx.base,
        'GET',
        '/api/v1/rewrites?page=1&pageSize=20',
        { token: merchant.token },
      );
      expect(listRes.status).toBe(200);
      expect(listRes.data.unitPoints).toBe(5);
      expect(listRes.data.total).toBeGreaterThanOrEqual(4);

      const csvRes = await httpCall<RewriteRecordItem[]>(
        ctx.base,
        'GET',
        '/api/v1/rewrites?export=csv',
        { token: merchant.token },
      );
      expect(csvRes.status).toBe(200);
      expect(csvRes.contentType).toContain('text/csv');
      expect(csvRes.raw.toString('utf8')).toContain('复刻新标题');

      // 10. 0-image rewrite without gallery succeeds with no <img> tags and null coverUrl
      const noImgRes = await httpCall<RewriteSingleCreateResponse>(
        ctx.base,
        'POST',
        '/api/v1/rewrites',
        {
          token: merchant.token,
          body: {
            url: 'https://mp.weixin.qq.com/wechat-sensor?zero=1',
            mediaCategoryId: null,
            imageCount: 0,
            templateId: 'sys_rewrite_01',
            categoryId: customCat.id,
          },
        },
      );
      expect(noImgRes.status).toBe(200);
      expect(noImgRes.data.record.mediaCategoryId).toBeNull();
      const noImgArticle = await httpCall<ArticleDetailRecord>(
        ctx.base,
        'GET',
        `/api/v1/articles/${noImgRes.data.record.articleId}`,
        { token: merchant.token },
      );
      expect(noImgArticle.status).toBe(200);
      expect(noImgArticle.data.coverUrl).toBeNull();
      expect(noImgArticle.data.contentHtml).not.toMatch(/<img\b/i);
    });
  },
);
