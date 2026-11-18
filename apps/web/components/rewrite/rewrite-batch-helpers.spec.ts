import {
  REWRITE_BATCH_URL_AS_KEYWORD_MSG,
  type MediaCategoryRecord,
  type RewriteBatchItem,
} from '@geomix/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BATCH_MAX_COUNT,
  INITIAL_BATCH_LIST_STATE,
  INITIAL_DRAWER_STATE,
  NO_IMAGE_GALLERY_VALUE,
  applyDraftNameChange,
  articleStatusTagColor,
  batchStatusTagColor,
  buildInitialDraft,
  computeEffectivePollInterval,
  computeEstimatedFreezePoints,
  deriveBatchPollingState,
  executeBatchControl,
  formatBatchKeywordSummary,
  formatCreatedBatchFeedback,
  formatTime,
  getBatchCategoryHref,
  getBatchNoteStyle,
  getBatchRowActions,
  hasKeywordUrlWarning,
  isActiveBatchStatus,
  isControllableBatchStatus,
  isCreateDraftDirty,
  isTerminalBatchStatus,
  itemStatusTagColor,
  mergeOptionsIntoListState,
  normalizeBatchPageSize,
  parseSourceFilter,
  parseStatusFilter,
  previewDraftLinkList,
  pruneTerminalSelection,
  shouldCloseDrawerOnDelete,
  shouldSyncOpenDrawer,
  toBatchListState,
  toErrorMessage,
  validateCreateDraft,
} from './rewrite-batch-helpers';

function makeMediaCategory(overrides: Partial<MediaCategoryRecord> = {}): MediaCategoryRecord {
  return {
    id: 'mcat_01',
    name: '企业产品实拍',
    type: 1,
    assetCount: 4,
    previewAssets: [],
    createdAt: '2026-11-17T08:00:00.000Z',
    ...overrides,
  };
}

function makeBatchItem(overrides: Partial<RewriteBatchItem> = {}): RewriteBatchItem {
  return {
    id: 'rwb_test_01',
    name: '批量复刻任务',
    keyword: '氮化镓充电器',
    sourceType: 'link_list',
    maxCount: 3,
    doneCount: 1,
    candidateCount: 3,
    failedOrSkippedCount: 0,
    categoryId: 'cat_01',
    categoryName: '批量爆文（复刻）',
    mediaCategoryId: 'mcat_01',
    mediaCategoryName: '企业产品实拍',
    templateId: 'tpl_01',
    templateName: '参考重写',
    status: 'RUNNING',
    note: null,
    unitPoints: 5,
    reservedPoints: 15,
    settledPoints: 5,
    releasedPoints: 0,
    createdAt: '2026-11-17T10:00:00.000Z',
    ...overrides,
  };
}

describe('rewrite-batch-helpers', () => {
  describe('buildInitialDraft', () => {
    it('enables noImage fallback when options are null, empty, or contain only 0-asset galleries', () => {
      expect(NO_IMAGE_GALLERY_VALUE).toBe('__NONE__');
      expect(DEFAULT_BATCH_MAX_COUNT).toBe(1);

      const fromNull = buildInitialDraft(null);
      expect(fromNull).toEqual({
        name: '',
        maxCount: 1,
        sourceType: 'link_list',
        keyword: '',
        linksText: '',
        mediaCategoryId: '',
        noImage: true,
        templateId: '',
        categoryId: '',
        autoCategoryName: '批量爆文（复刻）',
        resultStatus: 'PENDING',
        brand: '',
      });

      const fromEmpty = buildInitialDraft({ mediaCategories: [] });
      expect(fromEmpty.noImage).toBe(true);

      const fromZeroAsset = buildInitialDraft({
        mediaCategories: [makeMediaCategory({ assetCount: 0 })],
      });
      expect(fromZeroAsset.noImage).toBe(true);
      expect(fromZeroAsset.mediaCategoryId).toBe('');
    });

    it('defaults noImage to false with unselected mediaCategoryId when usable gallery exists', () => {
      const draft = buildInitialDraft({
        mediaCategories: [makeMediaCategory({ assetCount: 3 })],
      });
      expect(draft.noImage).toBe(false);
      expect(draft.mediaCategoryId).toBe('');
      expect(draft.maxCount).toBe(1);
      expect(draft.resultStatus).toBe('PENDING');
    });
  });

  describe('applyDraftNameChange, isCreateDraftDirty & computeEstimatedFreezePoints', () => {
    it('synchronizes autoCategoryName with task name and restores clean state when cleared', () => {
      const initial = buildInitialDraft({ mediaCategories: [makeMediaCategory()] });
      expect(isCreateDraftDirty(initial, initial)).toBe(false);

      const edited = applyDraftNameChange(initial, '行业干货');
      expect(edited.name).toBe('行业干货');
      expect(edited.autoCategoryName).toBe('行业干货（复刻）');
      expect(isCreateDraftDirty(edited, initial)).toBe(true);

      const alreadySuffixed = applyDraftNameChange(initial, '行业干货（复刻）');
      expect(alreadySuffixed.autoCategoryName).toBe('行业干货（复刻）');

      const cleared = applyDraftNameChange(edited, '');
      expect(cleared.autoCategoryName).toBe('批量爆文（复刻）');
      expect(isCreateDraftDirty(cleared, initial)).toBe(false);
    });

    it('detects dirty state on any field mutation and clamps estimated freeze points', () => {
      const initial = buildInitialDraft({ mediaCategories: [makeMediaCategory()] });
      expect(isCreateDraftDirty({ ...initial, brand: 'Anker' }, initial)).toBe(true);
      expect(isCreateDraftDirty({ ...initial, maxCount: 5 }, initial)).toBe(true);

      expect(computeEstimatedFreezePoints(3, 5)).toBe(15);
      expect(computeEstimatedFreezePoints(0, 5)).toBe(5);
      expect(computeEstimatedFreezePoints(Number.NaN, 5)).toBe(5);
      expect(computeEstimatedFreezePoints(2, 0)).toBe(10);
    });
  });

  describe('previewDraftLinkList & hasKeywordUrlWarning', () => {
    it('returns null in remote mode and summarizes valid, duplicate, excluded, and invalid/SSRF lines in link_list mode', () => {
      expect(
        previewDraftLinkList({ sourceType: 'remote', linksText: 'https://example.org/a' }),
      ).toBeNull();

      const validAndExcluded = previewDraftLinkList({
        sourceType: 'link_list',
        linksText: [
          'https://news.example.org/article-1',
          'https://news.example.org/article-1',
          'https://www.bilibili.com/video/BV1xx411c7mD',
          'https://item.jd.com/10001234.html',
          'https://portal.example.org/account/login',
        ].join('\n'),
      });
      expect(validAndExcluded).not.toBeNull();
      expect(validAndExcluded?.candidates).toHaveLength(1);
      expect(validAndExcluded?.duplicateLines).toEqual([2]);
      expect(validAndExcluded?.excludedLines).toHaveLength(3);
      expect(validAndExcluded?.firstInvalidWarning).toBeNull();

      const malformed = previewDraftLinkList({
        sourceType: 'link_list',
        linksText: 'not-a-valid-url',
      });
      expect(malformed?.firstInvalidWarning).toMatch(/^第 1 行：/);

      const ssrfLocal = previewDraftLinkList({
        sourceType: 'link_list',
        linksText: 'http://127.0.0.1:8080/internal\nhttp://localhost/admin',
      });
      expect(ssrfLocal?.invalidLines).toHaveLength(2);
      expect(ssrfLocal?.firstInvalidWarning).toContain('第 1 行：');
      expect(ssrfLocal?.firstInvalidWarning).toContain('内网与本地地址已拦截');
    });

    it('flags full URLs, www prefixes, and bare article domains in keyword fields', () => {
      expect(hasKeywordUrlWarning('https://mp.weixin.qq.com/s/abc')).toBe(true);
      expect(hasKeywordUrlWarning('www.example.com/post/1')).toBe(true);
      expect(hasKeywordUrlWarning('mp.weixin.qq.com/s/abc')).toBe(true);
      expect(hasKeywordUrlWarning('zhuanlan.zhihu.com/p/123456')).toBe(true);
      expect(hasKeywordUrlWarning('数控激光切割机维护指南')).toBe(false);
      expect(hasKeywordUrlWarning('   ')).toBe(false);
    });
  });

  describe('validateCreateDraft', () => {
    it('collects all 4 required issues in exact order on a blank draft with usable gallery', () => {
      const draft = buildInitialDraft({ mediaCategories: [makeMediaCategory()] });
      const res = validateCreateDraft(draft, {
        remoteSearchEnabled: false,
        mediaCategories: [makeMediaCategory()],
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.issues).toEqual([
          '请填写任务名称',
          '请至少粘贴 1 条公开文章链接（一行一条）',
          '请选择文章配图的企业画像图库分类（或选择「不配图（0 张）」）',
          '请选择爆文改写指令',
        ]);
        expect(res.errorMessage).toBe(res.issues.join('；'));
      }
    });

    it('enforces name length <= 60 and integer maxCount within 1–50', () => {
      const base = {
        ...buildInitialDraft(null),
        name: '测'.repeat(61),
        maxCount: 51,
        linksText: 'https://news.example.org/a1',
        templateId: 'tpl_01',
      };
      const overMax = validateCreateDraft(base, { remoteSearchEnabled: false });
      expect(overMax.ok).toBe(false);
      expect(overMax.issues).toEqual(['任务名称不超过 60 个字符', '最大改写量须在 1–50 篇之间']);

      const nonInt = validateCreateDraft(
        { ...base, name: '合规名称', maxCount: 1.5 },
        { remoteSearchEnabled: false },
      );
      expect(nonInt.ok).toBe(false);
      expect(nonInt.issues).toEqual(['最大改写量须在 1–50 篇之间']);

      const zeroCount = validateCreateDraft(
        { ...base, name: '合规名称', maxCount: 0 },
        { remoteSearchEnabled: false },
      );
      expect(zeroCount.ok).toBe(false);
      expect(zeroCount.issues).toEqual(['最大改写量须在 1–50 篇之间']);
    });

    it('validates remote mode empty keyword, URL-as-keyword, disabled flag, and valid submission', () => {
      const baseRemote = {
        ...buildInitialDraft(null),
        name: '远程寻源任务',
        sourceType: 'remote' as const,
        linksText: 'https://unused.example.org/should-be-omitted',
        templateId: 'tpl_01',
      };

      const emptyKw = validateCreateDraft(baseRemote, { remoteSearchEnabled: true });
      expect(emptyKw.issues).toEqual(['关键词全网搜索模式下请填写流量关键词']);

      const urlKw = validateCreateDraft(
        { ...baseRemote, keyword: 'https://zhuanlan.zhihu.com/p/123' },
        { remoteSearchEnabled: true },
      );
      expect(urlKw.issues).toEqual([REWRITE_BATCH_URL_AS_KEYWORD_MSG]);

      const disabledRemote = validateCreateDraft(
        { ...baseRemote, keyword: '工业激光焊接' },
        { remoteSearchEnabled: false },
      );
      expect(disabledRemote.issues).toEqual([
        '当前环境未配置第三方搜索源，「关键词全网搜索」暂未开通，请切换至「粘贴公开文章链接清单」',
      ]);

      const validRemote = validateCreateDraft(
        { ...baseRemote, keyword: '  工业激光焊接  ' },
        { remoteSearchEnabled: true },
      );
      expect(validRemote.ok).toBe(true);
      if (validRemote.ok) {
        expect(validRemote.payload.linksText).toBeUndefined();
        expect(validRemote.payload.keyword).toBe('工业激光焊接');
        expect(validRemote.payload.mediaCategoryId).toBeNull();
      }
    });

    it('validates link_list mode URL-in-keyword, invalid/SSRF URL, and all-excluded URLs', () => {
      const baseLink = {
        ...buildInitialDraft(null),
        name: '链接清单任务',
        sourceType: 'link_list' as const,
        templateId: 'tpl_01',
      };

      const badKwAndInvalidUrl = validateCreateDraft(
        {
          ...baseLink,
          keyword: 'mp.weixin.qq.com/s/mistake',
          linksText: 'http://192.168.1.1/private',
        },
        { remoteSearchEnabled: false },
      );
      expect(badKwAndInvalidUrl.ok).toBe(false);
      expect(badKwAndInvalidUrl.issues[0]).toBe(REWRITE_BATCH_URL_AS_KEYWORD_MSG);
      expect(badKwAndInvalidUrl.issues[1]).toContain('第 1 行链接不合法：');

      const allExcluded = validateCreateDraft(
        {
          ...baseLink,
          linksText: 'https://www.bilibili.com/video/BV1xx411c7mD',
        },
        { remoteSearchEnabled: false },
      );
      expect(allExcluded.ok).toBe(false);
      expect(allExcluded.issues).toEqual([
        '全部候选链接均不可用于正文复刻（第 1 行：视频页面不支持正文复刻）',
      ]);
    });

    it('rejects 0-asset selected gallery unless noImage is enabled and normalizes keyword vs brand independently', () => {
      const emptyCat = makeMediaCategory({ id: 'mcat_empty', assetCount: 0 });
      const usableCat = makeMediaCategory({ id: 'mcat_ok', assetCount: 5 });

      const zeroAssetSelected = validateCreateDraft(
        {
          ...buildInitialDraft({ mediaCategories: [usableCat, emptyCat] }),
          name: '配图校验测试',
          linksText: 'https://news.example.org/p1',
          mediaCategoryId: 'mcat_empty',
          noImage: false,
          templateId: 'tpl_01',
        },
        { remoteSearchEnabled: false, mediaCategories: [usableCat, emptyCat] },
      );
      expect(zeroAssetSelected.ok).toBe(false);
      expect(zeroAssetSelected.issues).toEqual([
        '所选企业画像图库分类暂无图片，请先上传图片或选择「不配图（0 张）」',
      ]);

      const validNormalized = validateCreateDraft(
        {
          ...buildInitialDraft({ mediaCategories: [usableCat] }),
          name: '  氮化镓快充批次  ',
          maxCount: 2,
          keyword: '  Anker氮化镓充电器  ',
          brand: '  Anker  ',
          linksText: 'https://news.example.org/p1',
          mediaCategoryId: 'mcat_ok',
          noImage: false,
          templateId: 'tpl_01',
          categoryId: '',
          resultStatus: 'NORMAL',
        },
        { remoteSearchEnabled: false, mediaCategories: [usableCat] },
      );
      expect(validNormalized.ok).toBe(true);
      if (validNormalized.ok) {
        expect(validNormalized.payload).toEqual({
          name: '氮化镓快充批次',
          maxCount: 2,
          sourceType: 'link_list',
          keyword: 'Anker氮化镓充电器',
          linksText: 'https://news.example.org/p1',
          mediaCategoryId: 'mcat_ok',
          templateId: 'tpl_01',
          categoryId: null,
          brand: 'Anker',
          resultStatus: 'NORMAL',
        });
      }

      const emptyBrand = validateCreateDraft(
        {
          ...buildInitialDraft(null),
          name: '无品牌任务',
          linksText: 'https://news.example.org/p1',
          templateId: 'tpl_01',
          brand: '   ',
        },
        { remoteSearchEnabled: false },
      );
      expect(emptyBrand.ok).toBe(true);
      if (emptyBrand.ok) {
        expect(emptyBrand.payload.brand).toBeUndefined();
        expect(emptyBrand.payload.mediaCategoryId).toBeNull();
      }
    });
  });

  describe('status mappers, polling/selection helpers & formatTime', () => {
    it('maps all task, item, and article statuses and partitions active/controllable/terminal states', () => {
      expect(batchStatusTagColor('QUEUED')).toBe('blue');
      expect(batchStatusTagColor('RUNNING')).toBe('processing');
      expect(batchStatusTagColor('PAUSED')).toBe('warning');
      expect(batchStatusTagColor('COMPLETED')).toBe('success');
      expect(batchStatusTagColor('PARTIAL')).toBe('gold');
      expect(batchStatusTagColor('FAILED')).toBe('error');
      expect(batchStatusTagColor('CANCELLED')).toBe('default');

      expect(itemStatusTagColor('PENDING')).toBe('blue');
      expect(itemStatusTagColor('RUNNING')).toBe('processing');
      expect(itemStatusTagColor('SUCCESS')).toBe('success');
      expect(itemStatusTagColor('FAILED')).toBe('error');
      expect(itemStatusTagColor('SKIPPED')).toBe('default');

      expect(articleStatusTagColor('NORMAL')).toBe('green');
      expect(articleStatusTagColor('PENDING')).toBe('gold');
      expect(articleStatusTagColor('DISABLED')).toBe('default');

      expect(isActiveBatchStatus('QUEUED')).toBe(true);
      expect(isActiveBatchStatus('RUNNING')).toBe(true);
      expect(isActiveBatchStatus('PAUSED')).toBe(false);
      expect(isTerminalBatchStatus('PAUSED')).toBe(false);
      expect(isControllableBatchStatus('PAUSED')).toBe(true);
      expect(isControllableBatchStatus('COMPLETED')).toBe(false);
      expect(isTerminalBatchStatus('COMPLETED')).toBe(true);
      expect(isTerminalBatchStatus('PARTIAL')).toBe(true);
      expect(isTerminalBatchStatus('FAILED')).toBe(true);
      expect(isTerminalBatchStatus('CANCELLED')).toBe(true);
    });

    it('computes effective poll interval, prunes non-terminal selection, syncs open drawer, and formats Asia/Shanghai time', async () => {
      expect(computeEffectivePollInterval(0, true)).toBe(0);
      expect(computeEffectivePollInterval(5_000, false)).toBe(5_000);
      expect(computeEffectivePollInterval(5_000, true)).toBe(1_500);
      expect(computeEffectivePollInterval(80, true)).toBe(80);

      expect(normalizeBatchPageSize(50)).toBe(50);
      expect(normalizeBatchPageSize(999)).toBe(25);

      const running = makeBatchItem({ id: 'b_run', status: 'RUNNING' });
      const done = makeBatchItem({ id: 'b_done', status: 'COMPLETED' });
      expect(pruneTerminalSelection(['b_run', 'b_done', 'b_missing'], [running, done])).toEqual([
        'b_done',
      ]);

      expect(shouldSyncOpenDrawer(done, [done])).toBeNull();
      expect(shouldSyncOpenDrawer(running, [running])).toEqual(running);
      const transitioned = makeBatchItem({ id: 'b_done', status: 'PARTIAL', doneCount: 2 });
      expect(shouldSyncOpenDrawer(done, [transitioned])).toEqual(transitioned);

      const pause = vi.fn(async () => makeBatchItem({ status: 'PAUSED' }));
      const resume = vi.fn(async () => makeBatchItem({ status: 'QUEUED' }));
      const cancel = vi.fn(async () => makeBatchItem({ status: 'CANCELLED', releasedPoints: 10 }));
      expect(await executeBatchControl({ pause, resume, cancel }, running, 'pause')).toBe(
        '已暂停任务「批量复刻任务」',
      );
      expect(await executeBatchControl({ pause, resume, cancel }, running, 'resume')).toBe(
        '已继续执行任务「批量复刻任务」',
      );
      expect(await executeBatchControl({ pause, resume, cancel }, running, 'cancel')).toBe(
        '已终止任务「批量复刻任务」，剩余预冻 10 点数已释放回账户',
      );

      expect(getBatchRowActions('QUEUED').map((a) => a.label)).toEqual(['暂停', '终止退点']);
      expect(getBatchRowActions('RUNNING').map((a) => a.label)).toEqual(['暂停', '终止退点']);
      expect(getBatchRowActions('PAUSED').map((a) => a.label)).toEqual(['继续', '终止退点']);
      expect(getBatchRowActions('COMPLETED').map((a) => a.label)).toEqual(['删除']);

      expect(
        toBatchListState({
          page: 1,
          pageSize: 25,
          total: 1,
          unitPoints: 0,
          remoteSearchEnabled: true,
          items: [done],
        }),
      ).toEqual({
        items: [done],
        total: 1,
        unitPoints: 5,
        remoteSearchEnabled: true,
      });

      expect(formatCreatedBatchFeedback({ batch: running, records: [] })).toContain(
        '批量复刻任务「批量复刻任务」已入队（预冻 15 点数',
      );
      expect(toErrorMessage(new Error('接口超时'), '默认提示')).toBe('接口超时');
      expect(toErrorMessage('raw', '默认提示')).toBe('默认提示');

      expect(formatTime(null)).toBe('—');
      expect(formatTime('')).toBe('—');
      expect(formatTime('2026-11-17T10:00:00.000Z')).toBe('2026-11-17 18:00');
    });

    it('derives polling state, drawer deletion guard, filter parsers, and category links', () => {
      const running = makeBatchItem({ id: 'b_run', status: 'RUNNING' });
      const done = makeBatchItem({
        id: 'b_done',
        status: 'COMPLETED',
        keyword: '',
        candidateCount: 4,
      });

      expect(deriveBatchPollingState([done], INITIAL_DRAWER_STATE, 5_000)).toEqual({
        drawerBatchId: null,
        drawerBatchActive: false,
        hasActiveBatch: false,
        effectiveInterval: 5_000,
      });

      const openActiveDrawer = {
        open: true,
        loading: false,
        detail: { batch: running, records: [] },
      };
      expect(deriveBatchPollingState([done], openActiveDrawer, 5_000)).toEqual({
        drawerBatchId: 'b_run',
        drawerBatchActive: true,
        hasActiveBatch: true,
        effectiveInterval: 1_500,
      });

      expect(shouldCloseDrawerOnDelete(openActiveDrawer, ['b_run'])).toBe(true);
      expect(shouldCloseDrawerOnDelete(openActiveDrawer, ['b_done'])).toBe(false);
      expect(shouldCloseDrawerOnDelete(INITIAL_DRAWER_STATE, ['b_run'])).toBe(false);

      expect(
        mergeOptionsIntoListState(INITIAL_BATCH_LIST_STATE, {
          unitPoints: 8,
          remoteSearchEnabled: true,
        }),
      ).toEqual({
        items: [],
        total: 0,
        unitPoints: 8,
        remoteSearchEnabled: true,
      });

      expect(getBatchCategoryHref('cat a/b')).toBe('/writing/articles?categoryId=cat%20a%2Fb');
      expect(formatBatchKeywordSummary(running)).toBe('氮化镓充电器');
      expect(formatBatchKeywordSummary(done)).toBe('链接清单（4 条候选）');
      expect(parseStatusFilter('')).toBeUndefined();
      expect(parseStatusFilter('RUNNING')).toBe('RUNNING');
      expect(parseSourceFilter('')).toBeUndefined();
      expect(parseSourceFilter('link_list')).toBe('link_list');
      expect(getBatchNoteStyle('FAILED').color).toBe('var(--gm-danger)');
      expect(getBatchNoteStyle('PARTIAL').color).toBe('var(--gm-fg-2)');
    });
  });
});
