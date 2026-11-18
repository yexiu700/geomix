// @vitest-environment jsdom

import {
  PROMPT_MISSING_CONVERSION_WARN,
  PROMPT_PLACEHOLDERS,
  PROMPT_REWRITE_BRAND_SWAP_WARN,
  PROMPT_TITLE_LOOKS_LIKE_BODY_WARN,
  analyzePromptWarnings,
  computePromptRandomPool,
  hasManualBrandSlot,
  type PromptKindName,
  type PromptTemplateRecord,
  type PromptWriteInput,
} from '@geomix/shared';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PromptGateway } from '../../lib/prompts';
import { PromptScreen } from './prompt-screen';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
});

function clickBtn(label: string): HTMLButtonElement {
  const target = label.replace(/\s+/g, '');
  const buttons = Array.from(document.querySelectorAll('button'));
  const found = buttons.find((b) => (b.textContent ?? '').replace(/\s+/g, '') === target);
  if (!found) {
    throw new Error(`button not found: ${label}`);
  }
  fireEvent.click(found);
  return found;
}

function makeGateway() {
  const systemItems: PromptTemplateRecord[] = [
    {
      id: 'sys_article_01',
      tenantId: null,
      isSystem: true,
      kind: 'ARTICLE',
      name: '系统·问题先答',
      content: '先用两句话直接回答{问题}，围绕{训练词占位符}展开，自然提及{转化词占位符}。',
      randomPool: true,
      hasManualSlot: false,
      sort: 1,
      clonedFrom: null,
      warnings: [],
      createdAt: '2026-11-17T01:00:00.000Z',
      updatedAt: '2026-11-17T01:00:00.000Z',
    },
    {
      id: 'sys_article_10',
      tenantId: null,
      isSystem: true,
      kind: 'ARTICLE',
      name: '系统·手工品牌槽位',
      content: '各用一段写【品牌1】和【品牌2】的适用条件，另起一段说明{转化词占位符}。',
      randomPool: false,
      hasManualSlot: true,
      sort: 10,
      clonedFrom: null,
      warnings: [],
      createdAt: '2026-11-17T01:00:00.000Z',
      updatedAt: '2026-11-17T01:00:00.000Z',
    },
  ];

  let userItems: PromptTemplateRecord[] = [
    {
      id: 'usr_1',
      tenantId: 't_1',
      isSystem: false,
      kind: 'ARTICLE',
      name: '工程机械选型指南指令',
      content: '围绕{问题}介绍{训练词占位符}选型标准与{转化词占位符}。',
      randomPool: true,
      hasManualSlot: false,
      sort: 0,
      clonedFrom: null,
      warnings: [],
      createdAt: '2026-11-17T04:00:00.000Z',
      updatedAt: '2026-11-17T04:00:00.000Z',
    },
    {
      id: 'usr_2',
      tenantId: 't_1',
      isSystem: false,
      kind: 'TITLE',
      name: '简明咨询标题指令',
      content: '围绕{问题}输出一行标题。',
      randomPool: true,
      hasManualSlot: false,
      sort: 0,
      clonedFrom: null,
      warnings: [],
      createdAt: '2026-11-17T04:20:00.000Z',
      updatedAt: '2026-11-17T04:20:00.000Z',
    },
    {
      id: 'usr_3',
      tenantId: 't_1',
      isSystem: false,
      kind: 'REWRITE',
      name: '行业文章参考重写',
      content: '参考原文重新创作，自然提及{转化词占位符}。',
      randomPool: true,
      hasManualSlot: false,
      sort: 0,
      clonedFrom: 'sys_rewrite_01',
      warnings: [],
      createdAt: '2026-11-17T04:30:00.000Z',
      updatedAt: '2026-11-17T04:30:00.000Z',
    },
  ];

  const createdPayloads: PromptWriteInput[] = [];
  const updatedPayloads: Array<{ id: string; payload: PromptWriteInput }> = [];

  const gateway: PromptGateway = {
    async list(query) {
      const needle = query.q?.trim().toLowerCase() ?? '';
      const filtered = userItems.filter(
        (item) =>
          (!query.kind || item.kind === query.kind) &&
          (!needle ||
            item.name.toLowerCase().includes(needle) ||
            item.content.toLowerCase().includes(needle)),
      );
      return {
        items: filtered,
        total: filtered.length,
        page: query.page,
        pageSize: query.pageSize,
      };
    },
    async listSystem(kind?: PromptKindName) {
      return {
        items: systemItems.filter((item) => !kind || item.kind === kind),
      };
    },
    async options(kind) {
      return {
        kind,
        system: systemItems.filter((i) => i.kind === kind),
        user: userItems.filter((i) => i.kind === kind),
      };
    },
    async create(payload) {
      createdPayloads.push(payload);
      const item: PromptTemplateRecord = {
        id: `usr_new_${createdPayloads.length}`,
        tenantId: 't_1',
        isSystem: false,
        kind: payload.kind,
        name: payload.name,
        content: payload.content,
        randomPool: computePromptRandomPool(payload.content),
        hasManualSlot: hasManualBrandSlot(payload.content),
        sort: 0,
        clonedFrom: null,
        warnings: analyzePromptWarnings(payload.kind, payload.content),
        createdAt: '2026-11-17T05:00:00.000Z',
        updatedAt: '2026-11-17T05:00:00.000Z',
      };
      userItems = [item, ...userItems];
      return item;
    },
    async update(id, payload) {
      updatedPayloads.push({ id, payload });
      userItems = userItems.map((i) =>
        i.id === id
          ? {
              ...i,
              kind: payload.kind,
              name: payload.name,
              content: payload.content,
              randomPool: computePromptRandomPool(payload.content),
              hasManualSlot: hasManualBrandSlot(payload.content),
              warnings: analyzePromptWarnings(payload.kind, payload.content),
            }
          : i,
      );
      return userItems.find((i) => i.id === id)!;
    },
    async clone(id) {
      const src = [...systemItems, ...userItems].find((i) => i.id === id)!;
      const cloned: PromptTemplateRecord = {
        ...src,
        id: `usr_clone_${Date.now()}`,
        tenantId: 't_1',
        isSystem: false,
        name: `${src.name}（副本）`,
        clonedFrom: src.id,
      };
      userItems = [cloned, ...userItems];
      return cloned;
    },
    async bulkDelete(ids) {
      userItems = userItems.filter((i) => !ids.includes(i.id));
      return { deleted: ids.length };
    },
    async download() {
      return { filename: 'prompts.csv', mime: 'text/csv', body: new Uint8Array() };
    },
  };

  return { gateway, createdPayloads, updatedPayloads };
}

describe('PromptScreen', () => {
  it('filters across ARTICLE/TITLE/REWRITE, opens read-only system drawer showing full body & manual-slot badge, and clones into edit modal', async () => {
    const { gateway, updatedPayloads } = makeGateway();
    render(<PromptScreen title="写作指令" gateway={gateway} />);

    await waitFor(() => {
      expect(document.body.textContent).toContain('工程机械选型指南指令');
    });

    const headers = Array.from(document.querySelectorAll('thead th'))
      .map((th) => (th.textContent ?? '').trim())
      .filter((txt) => txt.length > 0);
    expect(headers).toEqual(['指令名称', '创作类型', '创建时间', '操作']);

    // Filter by REWRITE -> only REWRITE row remains
    const rewriteRadio = Array.from(document.querySelectorAll('input[type="radio"]')).find(
      (el) => (el as HTMLInputElement).value === 'REWRITE',
    )!;
    fireEvent.click(rewriteRadio);

    await waitFor(() => {
      expect(document.body.textContent).toContain('行业文章参考重写');
      expect(document.body.textContent).not.toContain('工程机械选型指南指令');
    });

    // Switch back to ALL
    const allRadio = Array.from(document.querySelectorAll('input[type="radio"]')).find(
      (el) => (el as HTMLInputElement).value === 'ALL',
    )!;
    fireEvent.click(allRadio);

    // Open System Default Prompts Read-Only Drawer
    clickBtn('系统默认指令');

    await waitFor(() => {
      expect(document.body.textContent).toContain('系统·问题先答');
      expect(document.body.textContent).toContain('系统·手工品牌槽位');
      expect(document.body.textContent).toContain('含对比品牌槽位·需先克隆填写');
      expect(document.body.textContent).not.toContain('含手工槽位·不入随机池');
      // Full body is visible (not just name!)
      expect(document.body.textContent).toContain('先用两句话直接回答{问题}');
    });

    // Clone sys_article_10 -> opens Edit modal with cloned prompt so user can edit out 【品牌1】/【品牌2】
    await act(async () => {
      fireEvent.click(document.querySelector('button[aria-label="克隆-系统·手工品牌槽位"]')!);
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain('编辑写作指令');
    });
    const contentBox = document.querySelector(
      'textarea[aria-label="指令内容"]',
    ) as HTMLTextAreaElement;
    expect(contentBox.value).toContain('【品牌1】');

    fireEvent.change(contentBox, {
      target: { value: '客观对照激光与等离子适用条件，结尾自然提及{转化词占位符}。' },
    });

    await act(async () => {
      clickBtn('确定');
    });
    expect(updatedPayloads).toHaveLength(1);
  });

  it('defaults create form to ARTICLE, inserts placeholders, and displays non-blocking yellow warnings across kinds', async () => {
    const { gateway, createdPayloads } = makeGateway();
    render(<PromptScreen title="写作指令" gateway={gateway} />);

    await waitFor(() => {
      expect(document.body.textContent).toContain('工程机械选型指南指令');
    });

    clickBtn('添加');

    const nameInput = document.querySelector('input[aria-label="指令名称"]') as HTMLInputElement;
    const contentBox = document.querySelector(
      'textarea[aria-label="指令内容"]',
    ) as HTMLTextAreaElement;

    fireEvent.change(nameInput, { target: { value: '技术要点拆解指令' } });
    fireEvent.change(contentBox, { target: { value: '请围绕' } });

    // Insert {训练词占位符} via placeholder button -> missing {转化词占位符} triggers yellow warning
    fireEvent.click(document.querySelector('button[aria-label="插入-训练词占位符"]')!);
    expect(contentBox.value).toBe('请围绕{训练词占位符}');
    expect(document.body.textContent).toContain(PROMPT_MISSING_CONVERSION_WARN);

    // Check TITLE body-style warning & REWRITE brand-swap warning
    const modalRadios = () =>
      Array.from(document.querySelectorAll('.ant-modal input[type="radio"]')) as HTMLInputElement[];

    fireEvent.click(modalRadios().find((r) => r.value === 'TITLE')!);
    fireEvent.change(contentBox, {
      target: { value: '请围绕{问题}写一篇 1000 字的正文并拆分为三个小标题' },
    });
    expect(document.body.textContent).toContain(PROMPT_TITLE_LOOKS_LIKE_BODY_WARN);

    fireEvent.click(modalRadios().find((r) => r.value === 'REWRITE')!);
    fireEvent.change(contentBox, {
      target: { value: '请把原文推荐的第一个品牌换成{转化词占位符}' },
    });
    expect(document.body.textContent).toContain(PROMPT_REWRITE_BRAND_SWAP_WARN);

    // Switch back to ARTICLE and save even with missing {转化词占位符} warning (non-blocking!)
    fireEvent.click(modalRadios().find((r) => r.value === 'ARTICLE')!);
    fireEvent.change(contentBox, { target: { value: '围绕{问题}介绍{训练词占位符}技术要点' } });

    await act(async () => {
      clickBtn('确定');
    });

    expect(createdPayloads).toHaveLength(1);
    expect(createdPayloads[0]).toEqual({
      kind: 'ARTICLE',
      name: '技术要点拆解指令',
      content: '围绕{问题}介绍{训练词占位符}技术要点',
    });
  });

  it('scrolls validation error into view inside prompt modal (#151)', async () => {
    const scrollSpy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    const { gateway } = makeGateway();

    try {
      render(<PromptScreen title="写作指令" gateway={gateway} />);
      await waitFor(() => {
        expect(document.body.textContent).toContain('工程机械选型指南指令');
      });

      clickBtn('添加');
      await act(async () => {
        clickBtn('确定');
      });

      await waitFor(() => {
        expect(document.body.textContent).toContain('请输入指令名称');
        expect(document.body.textContent).toContain('请输入指令内容');
        expect(scrollSpy).toHaveBeenCalled();
      });
    } finally {
      scrollSpy.mockRestore();
    }
  });

  it('documents all 5 PROMPT_PLACEHOLDERS in the top Alert and shows prompt names & impact in delete modal (#155)', async () => {
    const { gateway } = makeGateway();
    render(<PromptScreen title="写作指令" gateway={gateway} />);

    await waitFor(() => {
      expect(document.body.textContent).toContain('工程机械选型指南指令');
    });

    const topAlert = document.querySelector('.ant-alert-warning');
    expect(topAlert).toBeTruthy();
    for (const ph of PROMPT_PLACEHOLDERS) {
      expect(topAlert?.textContent).toContain(ph.token);
      expect(topAlert?.textContent).toContain(ph.description);
    }

    // Row-level delete shows the exact prompt name and impact notice
    const rowDeleteBtns = Array.from(document.querySelectorAll('tbody tr td button')).filter((b) =>
      (b.textContent ?? '').replace(/\s+/g, '').includes('删除'),
    );
    fireEvent.click(rowDeleteBtns[0]!);
    await waitFor(() => {
      const dialog = document.querySelector('.ant-modal-content');
      expect(dialog?.textContent).toContain('「工程机械选型指南指令」');
      expect(dialog?.textContent).toContain(
        '删除后不可恢复，历史已生成任务不受影响；进行中的任务引用的指令禁止删除',
      );
    });
    clickBtn('取消');

    // Bulk delete shows selected prompt names
    const checkboxes = Array.from(
      document.querySelectorAll('tbody input[type="checkbox"]'),
    ) as HTMLInputElement[];
    fireEvent.click(checkboxes[0]!);
    fireEvent.click(checkboxes[1]!);
    clickBtn('删除');
    await waitFor(() => {
      const dialog = document.querySelector('.ant-modal-content');
      expect(dialog?.textContent).toContain('「工程机械选型指南指令」');
      expect(dialog?.textContent).toContain('「简明咨询标题指令」');
    });
  });

  it('prevents empty-state flash on 清空 after 0-result search and ignores stale out-of-order list responses (#155)', async () => {
    const { gateway } = makeGateway();
    const baseList = gateway.list;
    const heldResolvers: Array<{ q?: string; release: () => void }> = [];
    let holdPattern: 'NONE' | 'CLEAR' | 'STALE_SEARCH' = 'NONE';

    gateway.list = async (query) => {
      const result = await baseList(query);
      if (
        (holdPattern === 'CLEAR' && !query.q) ||
        (holdPattern === 'STALE_SEARCH' && Boolean(query.q))
      ) {
        await new Promise<void>((resolve) => {
          heldResolvers.push({ q: query.q, release: resolve });
        });
      }
      return result;
    };

    render(<PromptScreen title="写作指令" gateway={gateway} />);
    await waitFor(() => {
      expect(document.body.textContent).toContain('工程机械选型指南指令');
    });

    // Search for a non-existent keyword -> shows empty state
    clickBtn('搜索');
    const searchInput = document.querySelector(
      'input[aria-label="搜索关键字"]',
    ) as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: '完全不存在的指令' } });
    clickBtn('查询');

    await waitFor(() => {
      expect(document.body.textContent).toContain('没有找到匹配的记录');
    });

    // Hold the cleared list request and click 清空 -> loading must suppress emptyText immediately
    holdPattern = 'CLEAR';
    clickBtn('清空');

    expect(document.body.textContent).not.toContain('没有找到匹配的记录');

    await waitFor(() => {
      expect(heldResolvers.some((entry) => !entry.q)).toBe(true);
    });
    await act(async () => {
      heldResolvers.splice(0).forEach((entry) => entry.release());
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain('工程机械选型指南指令');
      expect(document.body.textContent).not.toContain('没有找到匹配的记录');
    });

    // Trigger a slow search, then immediately clear before it finishes;
    // resolving the stale 0-result search afterwards must not overwrite the cleared list.
    holdPattern = 'STALE_SEARCH';
    fireEvent.change(searchInput, { target: { value: '过期慢查询' } });
    clickBtn('查询');
    await waitFor(() => {
      expect(heldResolvers.some((entry) => entry.q === '过期慢查询')).toBe(true);
    });

    holdPattern = 'NONE';
    clickBtn('清空');
    await waitFor(() => {
      expect(document.body.textContent).toContain('工程机械选型指南指令');
    });

    await act(async () => {
      heldResolvers.splice(0).forEach((entry) => entry.release());
    });
    expect(document.body.textContent).toContain('工程机械选型指南指令');
    expect(document.body.textContent).not.toContain('没有找到匹配的记录');
  });

  it('places primary 添加 button before 刷新 and 删除 in toolbar (#260)', async () => {
    const { gateway } = makeGateway();
    render(<PromptScreen title="写作指令" gateway={gateway} />);
    await waitFor(() => {
      expect(document.body.textContent).toContain('工程机械选型指南指令');
    });

    const toolbarBtns = Array.from(
      document.querySelectorAll('.gm-crud-toolbar > .ant-space:first-child button'),
    ).map((btn) => (btn.textContent ?? '').replace(/\s+/g, ''));
    expect(toolbarBtns.slice(0, 3)).toEqual(['添加', '刷新', '删除']);
  });
});
