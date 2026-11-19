import type { PromptTemplateRecord } from '@geomix/shared';
import { describe, expect, it } from 'vitest';
import { AiTaskApiError, type AiTaskFormOptions } from '../../lib/ai-tasks';
import {
  buildAiTaskCreatePayload,
  buildAiTaskQuote,
  computeAiTaskQuote,
  defaultCreateDraft,
  filterUsableSystemArticlePrompts,
  findSelectedArticleTemplate,
  findSelectedKnowledgeBase,
  formatFailSkipSummary,
  formatTaskTime,
  isActiveTaskStatus,
  isControllableStatus,
  isGalleryRequiredError,
  isManualSlotTemplateBlocked,
  isTerminalTaskStatus,
  isUnauthorizedError,
  itemStatusTagColor,
  readInitialKeywordId,
  resolveBaseAiWritePoints,
  resolveKbAddonPoints,
  resolveTaskErrorMessage,
  statusTagColor,
  validateCreateDraft,
} from './ai-task-helpers';

function makePrompt(
  overrides: Partial<PromptTemplateRecord> & {
    id: string;
    kind: PromptTemplateRecord['kind'];
    name: string;
  },
): PromptTemplateRecord {
  return {
    tenantId: overrides.isSystem ? null : 'tenant_1',
    isSystem: false,
    content: '围绕{问题}介绍{训练词占位符}并提及{转化词占位符}。',
    randomPool: true,
    hasManualSlot: false,
    sort: 1,
    clonedFrom: null,
    warnings: [],
    createdAt: '2026-11-17T06:00:00.000Z',
    updatedAt: '2026-11-17T06:00:00.000Z',
    ...overrides,
  };
}

function makeOptions(): AiTaskFormOptions {
  return {
    generationMode: { bodySimulated: false, titleSimulated: false },
    categories: [
      {
        id: 'cat_1',
        name: '产品选购专题',
        total: 4,
        remaining: 2,
        createdAt: '2026-11-17T05:00:00.000Z',
      },
    ],
    keywords: [
      {
        id: 'kw_1',
        main: '光纤激光切割机',
        brands: ['智造星'],
        optStatus: 'NONE',
        questionCount: 8,
        createdAt: '2026-11-17T05:00:00.000Z',
      },
      {
        id: 'kw_empty',
        main: '暂无问题关键词',
        brands: ['智造星'],
        optStatus: 'NONE',
        questionCount: 0,
        createdAt: '2026-11-17T05:00:00.000Z',
      },
    ],
    mediaCategories: [
      {
        id: 'gal_1',
        name: '车间实拍图库',
        type: 1,
        assetCount: 5,
        previewAssets: [],
        createdAt: '2026-11-17T05:00:00.000Z',
      },
      {
        id: 'gal_empty',
        name: '空画像图库',
        type: 1,
        assetCount: 0,
        previewAssets: [],
        createdAt: '2026-11-17T05:00:00.000Z',
      },
    ],
    knowledgeBases: [
      {
        id: 'kb_ready',
        name: '智造星装备档案',
        mode: 'DETAIL',
        companyName: '苏州智造星激光装备有限公司',
        brandShort: '智造星',
        directions: ['需求痛点'],
        copyTypes: ['指南'],
        fields: null,
        summaryText: null,
        indexStatus: 'READY',
        chunkCount: 6,
        signatureId: 'sig_1',
        createdAt: '2026-11-17T05:00:00.000Z',
        updatedAt: '2026-11-17T05:00:00.000Z',
      },
      {
        id: 'kb_indexing',
        name: '索引中知识库',
        mode: 'SUMMARY',
        companyName: '苏州智造星激光装备有限公司',
        brandShort: '智造星',
        directions: ['需求痛点'],
        copyTypes: ['指南'],
        fields: null,
        summaryText: '摘要',
        indexStatus: 'INDEXING',
        chunkCount: 0,
        signatureId: 'sig_1',
        createdAt: '2026-11-17T05:00:00.000Z',
        updatedAt: '2026-11-17T05:00:00.000Z',
      },
    ],
    articlePrompts: {
      kind: 'ARTICLE',
      user: [
        makePrompt({ id: 'usr_art_clean', kind: 'ARTICLE', name: '我的深度测评模板' }),
        makePrompt({
          id: 'usr_art_slot',
          kind: 'ARTICLE',
          name: '未替换槽位克隆模板',
          hasManualSlot: true,
          clonedFrom: 'sys_art_slot',
        }),
      ],
      system: [
        makePrompt({
          id: 'sys_art_clean',
          kind: 'ARTICLE',
          name: '系统科普选购模板',
          isSystem: true,
        }),
        makePrompt({
          id: 'sys_art_slot',
          kind: 'ARTICLE',
          name: '多品牌横评对照模板',
          isSystem: true,
          hasManualSlot: true,
          randomPool: false,
        }),
      ],
    },
    titlePrompts: {
      kind: 'TITLE',
      user: [makePrompt({ id: 'usr_ttl_1', kind: 'TITLE', name: '我的简明标题指令' })],
      system: [
        makePrompt({ id: 'sys_ttl_1', kind: 'TITLE', name: '系统疑问句标题指令', isSystem: true }),
      ],
    },
    prices: [
      { action: 'ai_write', unitPoints: 10, enabled: true, label: '开始写作' },
      { action: 'kb_addon', unitPoints: 5, enabled: true, label: '知识库加价' },
    ],
  };
}

describe('readInitialKeywordId', () => {
  it('returns undefined when href is missing, empty, or lacks a query string', () => {
    expect(readInitialKeywordId()).toBeUndefined();
    expect(readInitialKeywordId('')).toBeUndefined();
    expect(readInitialKeywordId('/writing/tasks')).toBeUndefined();
  });

  it('returns undefined when keywordId param is absent, empty, or whitespace-only', () => {
    expect(readInitialKeywordId('/writing/tasks?page=2&status=RUNNING')).toBeUndefined();
    expect(readInitialKeywordId('/writing/tasks?keywordId=')).toBeUndefined();
    expect(readInitialKeywordId('/writing/tasks?keywordId=%20%20%09')).toBeUndefined();
  });

  it('extracts and trims keywordId from single and multi-param query strings', () => {
    expect(readInitialKeywordId('/writing/tasks?keywordId=kw_laser_01')).toBe('kw_laser_01');
    expect(
      readInitialKeywordId('/writing/tasks?from=keywords&keywordId=%20kw_laser_01%20&p=1'),
    ).toBe('kw_laser_01');
  });

  it('decodes URL-encoded characters, strips #hash fragments, and uses the first duplicate param', () => {
    expect(readInitialKeywordId('/writing/tasks?keywordId=kw%5Falpha-01#section-top')).toBe(
      'kw_alpha-01',
    );
    expect(
      readInitialKeywordId('/writing/tasks?keywordId=kw_first&keywordId=kw_second#drawer'),
    ).toBe('kw_first');
  });

  it('resolves keyword-scoped tab title and builds encoded article drill-down href', async () => {
    const { resolveAiTaskScreenTitle, buildCreatedArticlesHref } =
      await import('./ai-task-helpers');
    const options = makeOptions();
    expect(resolveAiTaskScreenTitle('AI写作任务', undefined, options)).toBe('AI写作任务');
    expect(resolveAiTaskScreenTitle('AI写作任务', 'kw_1', null)).toBe('AI写作任务');
    expect(resolveAiTaskScreenTitle('AI写作任务', 'kw_missing', options)).toBe('AI写作任务');
    expect(resolveAiTaskScreenTitle('AI写作任务', 'kw_1', options)).toBe(
      'AI写作任务 · 光纤激光切割机',
    );
    expect(buildCreatedArticlesHref({ id: 'task_run_1', categoryId: 'cat_laser_01' })).toBe(
      '/writing/articles?categoryId=cat_laser_01&taskId=task_run_1',
    );
  });
});

describe('defaultCreateDraft', () => {
  it('returns clean 10-field defaults when options or preferredKeywordId are absent', () => {
    expect(defaultCreateDraft(null)).toEqual({
      name: '',
      categoryId: '',
      keywordId: '',
      mediaCategoryId: '',
      imageCount: 1,
      kbId: '',
      contentTplId: '',
      titleTplId: '',
      resultStatus: 'PENDING',
      target: 1,
    });
    expect(defaultCreateDraft(null, 'kw_1').keywordId).toBe('');
  });

  it('prefills keywordId only when preferredKeywordId exists in tenant options', () => {
    const options = makeOptions();
    const matched = defaultCreateDraft(options, 'kw_1');
    expect(matched.keywordId).toBe('kw_1');
    expect(matched.mediaCategoryId).toBe('');
    expect(matched.categoryId).toBe('');
    expect(matched.kbId).toBe('');
    expect(matched.imageCount).toBe(1);
    expect(matched.target).toBe(1);

    const missing = defaultCreateDraft(options, 'kw_deleted_or_other_tenant');
    expect(missing.keywordId).toBe('');
  });
});

describe('resolveBaseAiWritePoints / resolveKbAddonPoints / computeAiTaskQuote', () => {
  it('falls back to PRICING_DEFAULTS when options are null, empty, or disabled', () => {
    expect(resolveBaseAiWritePoints(null)).toBe(10);
    expect(resolveKbAddonPoints(null)).toBe(5);

    const disabledOptions: AiTaskFormOptions = {
      ...makeOptions(),
      prices: [
        { action: 'ai_write', unitPoints: 25, enabled: false, label: '开始写作' },
        { action: 'kb_addon', unitPoints: 9, enabled: false, label: '知识库加价' },
      ],
    };
    expect(resolveBaseAiWritePoints(disabledOptions)).toBe(10);
    expect(resolveKbAddonPoints(disabledOptions)).toBe(5);
  });

  it('respects custom enabled prices from tenant pricing table', () => {
    const customOptions: AiTaskFormOptions = {
      ...makeOptions(),
      prices: [
        { action: 'ai_write', unitPoints: 12, enabled: true, label: '开始写作' },
        { action: 'kb_addon', unitPoints: 6, enabled: true, label: '知识库加价' },
      ],
    };
    const withoutKb = computeAiTaskQuote({ target: 2, kbId: '' }, customOptions);
    expect(withoutKb.unitPrice).toBe(12);
    expect(withoutKb.totalFrozen).toBe(24);
    expect(withoutKb.submitLabel).toBe('开始写作（12 点/篇）');

    const withKb = buildAiTaskQuote({ target: 2, kbId: 'kb_ready' }, customOptions);
    expect(withKb.unitPrice).toBe(18);
    expect(withKb.totalFrozen).toBe(36);
    expect(withKb.submitLabel).toBe('开始写作（18 点/篇）');
  });

  it('switches dynamically between 10 点/篇 and 15 点/篇 with upfront freeze scaling', () => {
    const options = makeOptions();
    const baseQuote = computeAiTaskQuote({ target: 1, kbId: '' }, options);
    expect(baseQuote.unitPrice).toBe(10);
    expect(baseQuote.totalFrozen).toBe(10);
    expect(baseQuote.submitLabel).toBe('开始写作（10 点/篇）');
    expect(baseQuote.text).toContain('预计预冻 10 点数（1 篇 × 10 点/篇）');
    expect(baseQuote.text).not.toContain('+5 点/篇');
    expect(baseQuote.text).not.toContain('整单预冻');

    const kbSingle = computeAiTaskQuote({ target: 1, kbId: 'kb_ready' }, options);
    expect(kbSingle.unitPrice).toBe(15);
    expect(kbSingle.totalFrozen).toBe(15);
    expect(kbSingle.submitLabel).toBe('开始写作（15 点/篇）');
    expect(kbSingle.text).toContain('已选用企业知识库（+5 点/篇）');
    expect(kbSingle.text).toContain('预计预冻 15 点数（1 篇 × 15 点/篇）');

    const kbBatch = computeAiTaskQuote({ target: 8, kbId: 'kb_ready' }, options);
    expect(kbBatch.unitPrice).toBe(15);
    expect(kbBatch.totalFrozen).toBe(120);
    expect(kbBatch.freezeText).toContain('120 点数（8 篇 × 15 点/篇）');
  });

  it('clamps non-positive, NaN, or fractional target counts safely', () => {
    const options = makeOptions();
    expect(computeAiTaskQuote({ target: 0, kbId: '' }, options).totalFrozen).toBe(10);
    expect(computeAiTaskQuote({ target: -5, kbId: '' }, options).totalFrozen).toBe(10);
    expect(computeAiTaskQuote({ target: Number.NaN, kbId: '' }, options).totalFrozen).toBe(10);
    expect(computeAiTaskQuote({ target: 3.8, kbId: 'kb_ready' }, options).totalFrozen).toBe(45);
    expect(computeAiTaskQuote(null, options).totalFrozen).toBe(100);
  });
});

describe('manual-slot template filtering, lookup, validation & payload builder', () => {
  it('excludes system manual-slot prompts while keeping user manual-slot prompts detectable', () => {
    expect(filterUsableSystemArticlePrompts(null)).toEqual([]);

    const options = makeOptions();
    const usableSystem = filterUsableSystemArticlePrompts(options);
    expect(usableSystem.map((t) => t.id)).toEqual(['sys_art_clean']);

    expect(findSelectedArticleTemplate(null, 'usr_art_clean')).toBeNull();
    expect(findSelectedArticleTemplate(options, '')).toBeNull();
    expect(findSelectedArticleTemplate(options, 'missing_tpl')).toBeNull();
    expect(findSelectedArticleTemplate(options, 'usr_art_slot')?.name).toBe('未替换槽位克隆模板');
    expect(findSelectedKnowledgeBase(options, 'kb_ready')?.name).toBe('智造星装备档案');
    expect(findSelectedKnowledgeBase(options, '')).toBeNull();

    expect(isManualSlotTemplateBlocked(options, '')).toBe(false);
    expect(isManualSlotTemplateBlocked(options, 'usr_art_clean')).toBe(false);
    expect(isManualSlotTemplateBlocked(options, 'sys_art_clean')).toBe(false);
    expect(isManualSlotTemplateBlocked(options, 'usr_art_slot')).toBe(true);
  });

  it('validates all required fields, empty assets/questions, indexing KB, manual slot, and target bounds', () => {
    const options = makeOptions();
    const emptyDraft = defaultCreateDraft(options);
    expect(validateCreateDraft(emptyDraft, options)).toEqual([
      '请填写任务名称',
      '请选择主关键词',
      '请选择画像图库',
    ]);

    // Pure-text mode (imageCount=0) bypasses gallery requirement
    const pureTextDraft = {
      ...emptyDraft,
      name: '  纯文科普任务  ',
      keywordId: 'kw_1',
      imageCount: 0,
      mediaCategoryId: 'gal_1',
      target: 5,
    };
    expect(validateCreateDraft(pureTextDraft, options)).toEqual([]);
    expect(buildAiTaskCreatePayload(pureTextDraft)).toEqual({
      name: '纯文科普任务',
      categoryId: null,
      keywordId: 'kw_1',
      mediaCategoryId: null,
      imageCount: 0,
      kbId: null,
      contentTplId: null,
      titleTplId: null,
      resultStatus: 'PENDING',
      target: 5,
    });

    // Zero-question keyword, zero-asset gallery, indexing KB, manual slot, and invalid target
    const invalidDraft = {
      ...emptyDraft,
      name: '异常校验任务',
      keywordId: 'kw_empty',
      mediaCategoryId: 'gal_empty',
      imageCount: 2,
      kbId: 'kb_indexing',
      contentTplId: 'usr_art_slot',
      target: 101,
    };
    expect(validateCreateDraft(invalidDraft, options)).toEqual([
      '所选主关键词下暂无写作问题，请先前往「写作标题」添加问题',
      '所选画像图库暂无图片，请先上传图片或将文章配图调为 0 张',
      '所选企业知识库正在建立智能检索，请变为「可用」后再提交任务',
      '所选内容创作指令仍含【品牌1】等手工槽位，请先前往「写作指令」填写具体对比品牌后再选用',
      'AI 创作数量需在 1–100 篇之间',
    ]);

    expect(validateCreateDraft({ ...pureTextDraft, target: 0 }, options)).toContain(
      'AI 创作数量需在 1–100 篇之间',
    );
    expect(validateCreateDraft({ ...pureTextDraft, target: 2.5 }, options)).toContain(
      'AI 创作数量需在 1–100 篇之间',
    );

    expect(isGalleryRequiredError('请选择画像图库')).toBe(true);
    expect(isGalleryRequiredError('所选画像图库暂无图片，请先上传图片或将文章配图调为 0 张')).toBe(
      true,
    );
    expect(isGalleryRequiredError('请填写任务名称')).toBe(false);
    expect(isGalleryRequiredError(null)).toBe(false);
  });
});

describe('status, time, summary & error helpers', () => {
  it('maps all 7 task statuses and 5 item statuses to expected AntD Tag colors', () => {
    expect(statusTagColor('RUNNING')).toBe('processing');
    expect(statusTagColor('COMPLETED')).toBe('success');
    expect(statusTagColor('PAUSED')).toBe('warning');
    expect(statusTagColor('PARTIAL')).toBe('gold');
    expect(statusTagColor('FAILED')).toBe('error');
    expect(statusTagColor('CANCELLED')).toBe('default');
    expect(statusTagColor('QUEUED')).toBe('blue');

    expect(itemStatusTagColor('RUNNING')).toBe('processing');
    expect(itemStatusTagColor('SUCCESS')).toBe('success');
    expect(itemStatusTagColor('FAILED')).toBe('error');
    expect(itemStatusTagColor('SKIPPED')).toBe('default');
    expect(itemStatusTagColor('PENDING')).toBe('blue');
  });

  it('evaluates active, controllable, and terminal task lifecycle predicates', () => {
    expect(isActiveTaskStatus('QUEUED')).toBe(true);
    expect(isActiveTaskStatus('RUNNING')).toBe(true);
    for (const st of ['PAUSED', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'] as const) {
      expect(isActiveTaskStatus(st)).toBe(false);
    }

    for (const st of ['QUEUED', 'RUNNING', 'PAUSED'] as const) {
      expect(isControllableStatus(st)).toBe(true);
      expect(isTerminalTaskStatus(st)).toBe(false);
    }
    for (const st of ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'] as const) {
      expect(isControllableStatus(st)).toBe(false);
      expect(isTerminalTaskStatus(st)).toBe(true);
    }
  });

  it('identifies HTTP 401 unauthorized errors and formats fallback error messages', () => {
    expect(isUnauthorizedError(new AiTaskApiError(401, 40101, '未登录'))).toBe(true);
    expect(isUnauthorizedError({ status: 401 })).toBe(true);
    expect(isUnauthorizedError(new AiTaskApiError(403, 40301, '无权限'))).toBe(false);
    expect(isUnauthorizedError(new AiTaskApiError(500, -1, '服务异常'))).toBe(false);
    expect(isUnauthorizedError({ status: 500 })).toBe(false);
    expect(isUnauthorizedError(new Error('network'))).toBe(false);
    expect(isUnauthorizedError(null)).toBe(false);
    expect(isUnauthorizedError(undefined)).toBe(false);
    expect(isUnauthorizedError('401')).toBe(false);

    expect(resolveTaskErrorMessage(new Error('上游繁忙'), '默认错误')).toBe('上游繁忙');
    expect(resolveTaskErrorMessage(new Error(''), '默认错误')).toBe('默认错误');
    expect(resolveTaskErrorMessage('raw', '默认错误')).toBe('默认错误');
  });

  it('formats Shanghai timestamps and fail/skip summaries accurately', () => {
    expect(formatTaskTime(null)).toBe('—');
    expect(formatTaskTime(undefined)).toBe('—');
    expect(formatTaskTime('')).toBe('—');
    expect(formatTaskTime('2026-11-17T06:30:00.000Z')).toBe('2026-11-17 14:30');

    expect(formatFailSkipSummary(0, 0)).toBeNull();
    expect(formatFailSkipSummary(2, 0)).toBe('失败 2');
    expect(formatFailSkipSummary(0, 3)).toBe('跳过 3');
    expect(formatFailSkipSummary(2, 3)).toBe('失败 2 · 跳过 3');
  });
});
