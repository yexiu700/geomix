// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AiTaskDetailRecord, AiTaskRecord, PromptTemplateRecord } from '@geomix/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiTaskFormOptions, AiTaskGateway } from '../../lib/ai-tasks';
import type { ShellAction } from '../../lib/tab-stack';
import { AiTaskScreen } from './ai-task-screen';

function findButton(labelOrText: string): HTMLButtonElement {
  const byLabel = document.querySelector(`button[aria-label="${labelOrText}"]`);
  if (byLabel instanceof HTMLButtonElement) return byLabel;
  const all = Array.from(document.querySelectorAll('button'));
  const normalized = labelOrText.replace(/\s+/g, '');
  const match = all.find((btn) => (btn.textContent ?? '').replace(/\s+/g, '') === normalized);
  if (!match) {
    throw new Error(`Button not found: ${labelOrText}`);
  }
  return match;
}

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

function makeTaskRow(overrides: Partial<AiTaskRecord> = {}): AiTaskRecord {
  return {
    id: 'task_run_1',
    name: '十篇激光选型计划',
    categoryId: 'cat_laser_000000000001',
    categoryName: '激光选型指南',
    keywordId: 'kw_1',
    keywordMain: '光纤激光切割机',
    mediaCategoryId: 'gal_1',
    mediaCategoryName: '车间实拍图库',
    imageCount: 2,
    kbId: 'kb_1',
    kbName: '智造星装备档案',
    contentTplId: null,
    contentTplName: null,
    titleTplId: null,
    titleTplName: null,
    resultStatus: 'PENDING',
    target: 10,
    doneCount: 3,
    failCount: 0,
    skipCount: 0,
    unitPrice: 15,
    frozenPoints: 150,
    settledPoints: 45,
    releasedPoints: 0,
    status: 'RUNNING',
    lastError: null,
    lastWrittenAt: '2026-11-17T06:30:00.000Z',
    createdAt: '2026-11-17T06:20:00.000Z',
    ...overrides,
  };
}

function makeFormOptions(): AiTaskFormOptions {
  return {
    categories: [
      {
        id: 'cat_laser_000000000001',
        name: '激光选型指南',
        total: 6,
        remaining: 4,
        createdAt: '2026-11-17T05:00:00.000Z',
      },
    ],
    keywords: [
      {
        id: 'kw_1',
        main: '光纤激光切割机',
        brands: ['智造星', '华锐精工'],
        optStatus: 'NONE',
        questionCount: 12,
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
    ],
    knowledgeBases: [
      {
        id: 'kb_1',
        name: '智造星装备档案',
        mode: 'DETAIL',
        companyName: '苏州智造星激光装备有限公司',
        brandShort: '智造星',
        directions: ['需求痛点'],
        copyTypes: ['指南'],
        fields: null,
        summaryText: null,
        indexStatus: 'READY',
        chunkCount: 0,
        signatureId: 'sig_1',
        createdAt: '2026-11-17T05:00:00.000Z',
        updatedAt: '2026-11-17T05:00:00.000Z',
      },
    ],
    articlePrompts: {
      kind: 'ARTICLE',
      user: [makePrompt({ id: 'usr_art_1', kind: 'ARTICLE', name: '我的深度测评模板' })],
      system: [
        makePrompt({ id: 'sys_art_1', kind: 'ARTICLE', name: '系统科普选购模板', isSystem: true }),
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

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('AiTaskScreen', () => {
  it('renders 11 task columns, opens item detail drawer, dispatches article view, and polls every 5s from 创作中 to 创作完成', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    let pollCount = 0;
    const runningRow = makeTaskRow({ status: 'RUNNING', doneCount: 3 });
    const completedRow = makeTaskRow({
      status: 'COMPLETED',
      doneCount: 10,
      settledPoints: 150,
    });

    const detailRecord: AiTaskDetailRecord = {
      ...runningRow,
      items: [
        {
          id: 'item_1',
          seq: 1,
          questionId: 'q_1',
          questionText: '中厚板光纤激光切割机如何评估床身退火稳定性？',
          templateId: 'sys_art_1',
          direction: '需求痛点',
          copyType: '指南',
          brand: '智造星',
          title: '中厚板光纤激光切割机如何评估床身退火稳定性？',
          status: 'SUCCESS',
          attempts: 1,
          model: 'fake-quality',
          tokensIn: 320,
          tokensOut: 980,
          error: null,
          articleId: 'art_1',
          startedAt: '2026-11-17T06:21:00.000Z',
          finishedAt: '2026-11-17T06:21:10.000Z',
        },
      ],
    };

    const actions: ShellAction[] = [];
    const gateway: AiTaskGateway = {
      list: vi.fn(async () => {
        pollCount += 1;
        const item = pollCount >= 2 ? completedRow : runningRow;
        return { page: 1, pageSize: 10, total: 1, items: [item] };
      }),
      detail: vi.fn(async () => detailRecord),
      create: vi.fn(),
      pause: vi.fn(async () => ({ ...detailRecord, status: 'PAUSED' as const })),
      resume: vi.fn(),
      cancel: vi.fn(),
      bulkDelete: vi.fn(),
      download: vi.fn(),
      loadFormOptions: vi.fn(async () => makeFormOptions()),
    };

    render(
      <AiTaskScreen
        title="AI写作任务"
        tabId="tab_tasks"
        pollIntervalMs={5_000}
        gateway={gateway}
        onDispatch={(act) => actions.push(act)}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('十篇激光选型计划')).toBeTruthy();
    });
    const rowEl = screen.getByText('十篇激光选型计划').closest('tr');
    expect(rowEl?.textContent).toContain('创作中');
    expect(screen.getByText('3 / 10')).toBeTruthy();

    // Verify all 11 column headers are present
    for (const colTitle of [
      '任务名',
      '蒸馏词',
      '创作上限',
      '已创作',
      '知识库',
      '详情',
      '错误消息',
      '状态',
      '最新写作',
      '创建时间',
      '操作',
    ]) {
      expect(screen.getAllByText(colTitle).length).toBeGreaterThan(0);
    }

    // Open detail drawer and verify AiTaskItem row
    fireEvent.click(findButton('查看详情-十篇激光选型计划'));
    await waitFor(() => {
      expect(screen.getByText('中厚板光纤激光切割机如何评估床身退火稳定性？')).toBeTruthy();
    });
    expect(screen.getByText(/单价 15 点\/篇/)).toBeTruthy();

    // Click 查看创作内容 -> dispatches /writing/articles?categoryId=...&taskId=...
    fireEvent.click(findButton('查看创作内容-十篇激光选型计划'));
    expect(actions).toContainEqual({
      type: 'open',
      href: '/writing/articles?categoryId=cat_laser_000000000001&taskId=task_run_1',
      sourceId: 'tab_tasks',
    });

    // Advance 5 seconds -> automatic polling transitions status to 创作完成 (10 / 10)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    await waitFor(() => {
      const updatedRow = screen.getByText('十篇激光选型计划').closest('tr');
      expect(updatedRow?.textContent).toContain('创作完成');
      expect(screen.getByText('10 / 10')).toBeTruthy();
    });
  });

  it('defaults 10 form fields per spec, filters ARTICLE vs TITLE prompts, guards manual-slot templates, and switches button between 10点数/篇 and 15点数/篇 when KB is selected', async () => {
    let submittedPayload: unknown = null;
    const createdDetail: AiTaskDetailRecord = {
      ...makeTaskRow({ name: '春季钣金获客任务', target: 8, unitPrice: 15, frozenPoints: 120 }),
      items: [],
    };

    const gateway: AiTaskGateway = {
      list: vi.fn(async () => ({ page: 1, pageSize: 10, total: 0, items: [] })),
      detail: vi.fn(),
      create: vi.fn(async (payload) => {
        submittedPayload = payload;
        return createdDetail;
      }),
      pause: vi.fn(),
      resume: vi.fn(),
      cancel: vi.fn(),
      bulkDelete: vi.fn(),
      download: vi.fn(),
      loadFormOptions: vi.fn(async () => makeFormOptions()),
    };

    render(
      <AiTaskScreen title="AI写作任务" tabId="tab_tasks" pollIntervalMs={0} gateway={gateway} />,
    );

    await waitFor(() => {
      expect(gateway.list).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(findButton('添加'));

    await waitFor(() => {
      expect(screen.getByLabelText('任务名称')).toBeTruthy();
    });

    // 1. Check default button label (10点数/篇), target=1, unselected keyword/gallery (#74), and default pre-freeze summary (1 篇 × 10 点/篇 = 10 点)
    expect(findButton('开始写作（10点数/篇）')).toBeTruthy();
    expect((screen.getByLabelText('AI 创作数量') as HTMLInputElement).value).toBe('1');
    const kwSelect = screen.getByLabelText('蒸馏训练词') as HTMLSelectElement;
    const galSelect = screen.getByLabelText('画像图库') as HTMLSelectElement;
    expect(kwSelect.value).toBe('');
    expect(galSelect.value).toBe('');
    expect(screen.getByTestId('ai-task-freeze-banner').textContent).toContain(
      '10 点数（1 篇 × 10 点/篇）',
    );
    expect(screen.getByText('1 张/篇')).toBeTruthy();

    // 2. Verify strict PromptKind separation in dropdown options
    const contentSelect = screen.getByLabelText('内容创作指令') as HTMLSelectElement;
    const titleSelect = screen.getByLabelText('标题创作指令') as HTMLSelectElement;
    expect(contentSelect.value).toBe('');
    expect(titleSelect.value).toBe('');
    expect(contentSelect.textContent).toContain('我的深度测评模板');
    expect(contentSelect.textContent).not.toContain('我的简明标题指令');
    expect(titleSelect.textContent).toContain('我的简明标题指令');
    expect(titleSelect.textContent).not.toContain('我的深度测评模板');

    // 3. Selecting manual-slot system template warns and disables submit until changed
    fireEvent.change(contentSelect, { target: { value: 'sys_art_slot' } });
    expect(screen.getByText(/请先前往「写作指令」克隆并填写具体对标品牌/)).toBeTruthy();
    expect(findButton('开始写作（10点数/篇）').disabled).toBe(true);

    fireEvent.change(contentSelect, { target: { value: 'usr_art_1' } });
    expect(findButton('开始写作（10点数/篇）').disabled).toBe(false);

    // 4. Selecting Enterprise Knowledge Base immediately switches button to 开始写作（15点数/篇） and updates pre-freeze total!
    const kbSelect = screen.getByLabelText('企业知识库') as HTMLSelectElement;
    fireEvent.change(kbSelect, { target: { value: 'kb_1' } });

    expect(findButton('开始写作（15点数/篇）')).toBeTruthy();
    expect(screen.getByTestId('ai-task-freeze-banner').textContent).toContain('+5 点/篇');
    expect(screen.getByTestId('ai-task-freeze-banner').textContent).toContain(
      '15 点数（1 篇 × 15 点/篇）',
    );

    // Clear KB -> switches back to 开始写作（10点数/篇）; re-select KB -> 开始写作（15点数/篇）
    fireEvent.change(kbSelect, { target: { value: '' } });
    expect(findButton('开始写作（10点数/篇）')).toBeTruthy();
    fireEvent.change(kbSelect, { target: { value: 'kb_1' } });
    expect(findButton('开始写作（15点数/篇）')).toBeTruthy();

    // Fill name, explicitly select keyword & gallery (#74), adjust target to 8 -> banner updates to 120 点数（8 篇 × 15 点/篇） and submit!
    fireEvent.change(screen.getByLabelText('任务名称'), {
      target: { value: '春季钣金获客任务' },
    });
    fireEvent.change(kwSelect, { target: { value: 'kw_1' } });
    fireEvent.change(galSelect, { target: { value: 'gal_1' } });
    fireEvent.change(screen.getByLabelText('AI 创作数量'), {
      target: { value: '8' },
    });
    expect(screen.getByTestId('ai-task-freeze-banner').textContent).toContain(
      '120 点数（8 篇 × 15 点/篇）',
    );

    fireEvent.click(findButton('开始写作（15点数/篇）'));

    await waitFor(() => {
      expect(gateway.create).toHaveBeenCalledTimes(1);
    });
    expect(submittedPayload).toEqual({
      name: '春季钣金获客任务',
      categoryId: null,
      keywordId: 'kw_1',
      mediaCategoryId: 'gal_1',
      imageCount: 1,
      kbId: 'kb_1',
      contentTplId: 'usr_art_1',
      titleTplId: null,
      resultStatus: 'PENDING',
      target: 8,
    });
  });

  it('allows pure-text submit with imageCount=0 and no gallery (#148), minimizes on 去新建图库, and refreshes dropdowns on restore', async () => {
    let optionsLoadCount = 0;
    const baseOptions = makeFormOptions();
    baseOptions.mediaCategories = [];
    const refreshedOptions = makeFormOptions();
    refreshedOptions.mediaCategories.push({
      id: 'gal_new',
      name: '新建产线图库',
      type: 1,
      assetCount: 2,
      previewAssets: [],
      createdAt: '2026-11-18T00:00:00.000Z',
    });
    refreshedOptions.articlePrompts.user.push(
      makePrompt({ id: 'usr_art_2', kind: 'ARTICLE', name: '新建纯文指令' }),
    );

    const createdPayloads: unknown[] = [];
    const actions: ShellAction[] = [];
    const gateway: AiTaskGateway = {
      list: vi.fn(async () => ({
        page: 1,
        pageSize: 10,
        total: 1,
        items: [
          makeTaskRow({
            lastError: '模型调用超时：上游网关在 30 秒内未响应，已自动记录失败原因',
          }),
        ],
      })),
      detail: vi.fn(),
      create: vi.fn(async (payload) => {
        createdPayloads.push(payload);
        return {
          ...makeTaskRow({
            name: payload.name,
            mediaCategoryId: payload.mediaCategoryId ?? null,
            mediaCategoryName: null,
            imageCount: payload.imageCount,
          }),
          items: [],
        };
      }),
      pause: vi.fn(),
      resume: vi.fn(),
      cancel: vi.fn(),
      bulkDelete: vi.fn(),
      download: vi.fn(),
      loadFormOptions: vi.fn(async () => {
        optionsLoadCount += 1;
        return optionsLoadCount >= 2 ? refreshedOptions : baseOptions;
      }),
    };

    render(
      <AiTaskScreen
        title="AI写作任务"
        tabId="tab_tasks"
        pollIntervalMs={0}
        gateway={gateway}
        onDispatch={(act) => actions.push(act)}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('十篇激光选型计划')).toBeTruthy();
    });

    // #154: doneCount ratio prevents slash line-wrapping; long lastError uses 2-line clamp
    const ratioEl = screen.getByText('3 / 10');
    expect(ratioEl.style.whiteSpace).toBe('nowrap');
    const errorEl = screen.getByText('模型调用超时：上游网关在 30 秒内未响应，已自动记录失败原因');
    expect(errorEl.className).toContain('gm-clamp-2');

    fireEvent.click(findButton('添加'));
    await waitFor(() => {
      expect(screen.getByLabelText('任务名称')).toBeTruthy();
    });

    // #151: submitting empty form renders CrudModal footer error alert with all missing required fields
    fireEvent.click(findButton('开始写作（10点数/篇）'));
    await waitFor(() => {
      const errorText = document.querySelector('.gm-crud-error')?.textContent ?? '';
      expect(errorText).toContain('请填写任务名称');
      expect(errorText).toContain('请选择蒸馏训练词');
      expect(errorText).toContain('请选择画像图库');
    });

    // Fill fields before minimizing via 去新建图库
    fireEvent.change(screen.getByLabelText('任务名称'), {
      target: { value: '纯文与还原刷新验证' },
    });
    fireEvent.change(screen.getByLabelText('蒸馏训练词'), {
      target: { value: 'kw_1' },
    });
    fireEvent.change(screen.getByLabelText('AI 创作数量'), {
      target: { value: '5' },
    });

    // #148: clicking 去新建图库 minimizes modal and navigates to /material/gallery
    fireEvent.click(findButton('去新建图库'));
    expect(actions).toContainEqual({
      type: 'open',
      href: '/material/gallery',
      sourceId: 'tab_tasks',
    });
    expect(findButton('还原弹层')).toBeTruthy();

    // #148: restoring minimized modal auto-refreshes gallery/prompt dropdowns AND preserves draft!
    fireEvent.click(findButton('还原弹层'));
    await waitFor(() => {
      expect(optionsLoadCount).toBe(2);
      expect((screen.getByLabelText('画像图库') as HTMLSelectElement).textContent).toContain(
        '新建产线图库',
      );
    });
    expect((screen.getByLabelText('内容创作指令') as HTMLSelectElement).textContent).toContain(
      '新建纯文指令',
    );
    expect((screen.getByLabelText('任务名称') as HTMLInputElement).value).toBe(
      '纯文与还原刷新验证',
    );
    expect((screen.getByLabelText('蒸馏训练词') as HTMLSelectElement).value).toBe('kw_1');
    expect((screen.getByLabelText('AI 创作数量') as HTMLInputElement).value).toBe('5');

    // #148: drag/click 文章配图 to 0 张 -> disables 画像图库, removes * required check, submits pure-text task
    fireEvent.click(screen.getByText('0张'));
    expect(screen.getByText('0 张/篇')).toBeTruthy();
    const galSelect = screen.getByLabelText('画像图库') as HTMLSelectElement;
    expect(galSelect.disabled).toBe(true);
    expect(document.body.textContent).toContain('画像图库（0 张配图时无需选择）');

    fireEvent.click(findButton('开始写作（10点数/篇）'));
    await waitFor(() => {
      expect(createdPayloads).toHaveLength(1);
    });
    expect(createdPayloads[0]).toEqual({
      name: '纯文与还原刷新验证',
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
  });
});
