// @vitest-environment jsdom

import {
  KB_AGREEMENT_CONFIRM_BUTTON_LABEL,
  KB_AGREEMENT_KIND,
  KB_AGREEMENT_VERSION,
  KB_UNSIGNED_ERROR_MSG,
  emptyKbDetailFields,
  type AgreementStatusView,
  type KnowledgeBaseRecord,
  type KnowledgeWriteInput,
} from '@geomix/shared';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { KnowledgeGateway } from '../../lib/knowledge';
import { KnowledgeScreen } from './knowledge-screen';

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

function findBtn(label: string): HTMLButtonElement | undefined {
  const target = label.replace(/\s+/g, '');
  return Array.from(document.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').replace(/\s+/g, '') === target,
  );
}

function makeGateway(opts?: { signed?: boolean }) {
  let agreement: AgreementStatusView = {
    kind: KB_AGREEMENT_KIND,
    version: KB_AGREEMENT_VERSION,
    signed: Boolean(opts?.signed),
    signatureId: opts?.signed ? 'sig_1' : null,
    signedAt: opts?.signed ? '2026-11-17T05:00:00.000Z' : null,
  };

  let items: KnowledgeBaseRecord[] = [
    {
      id: 'kb_detail_1',
      name: '激光装备产品库',
      mode: 'DETAIL',
      companyName: '苏州智造装备有限公司',
      brandShort: '智造星',
      directions: ['产品说明', '需求痛点'],
      copyTypes: ['说明文', '指南'],
      fields: {
        ...emptyKbDetailFields(),
        productService: '主营光纤激光切割设备及自动化产线。',
      },
      summaryText: null,
      indexStatus: 'NONE',
      chunkCount: 0,
      signatureId: 'sig_0',
      createdAt: '2026-11-17T04:00:00.000Z',
      updatedAt: '2026-11-17T04:00:00.000Z',
    },
    {
      id: 'kb_sum_1',
      name: '两万字工艺总览',
      mode: 'SUMMARY',
      companyName: null,
      brandShort: null,
      directions: [],
      copyTypes: [],
      fields: null,
      summaryText: '长文本技术资料...',
      indexStatus: 'READY',
      chunkCount: 38,
      signatureId: 'sig_0',
      createdAt: '2026-11-17T04:30:00.000Z',
      updatedAt: '2026-11-17T04:30:00.000Z',
    },
  ];

  const createdPayloads: KnowledgeWriteInput[] = [];
  let signCalls = 0;

  const gateway: KnowledgeGateway = {
    async list(query) {
      return {
        items,
        total: items.length,
        page: query.page,
        pageSize: query.pageSize,
        agreement,
      };
    },
    async detail(id) {
      return items.find((i) => i.id === id)!;
    },
    async create(payload) {
      createdPayloads.push(payload);
      const created: KnowledgeBaseRecord = {
        id: `kb_new_${createdPayloads.length}`,
        name: payload.name,
        mode: payload.mode,
        companyName: payload.mode === 'DETAIL' ? payload.companyName : null,
        brandShort: payload.mode === 'DETAIL' ? payload.brandShort : null,
        directions: payload.mode === 'DETAIL' ? payload.directions : [],
        copyTypes: payload.mode === 'DETAIL' ? payload.copyTypes : [],
        fields: payload.mode === 'DETAIL' ? payload.fields : null,
        summaryText: payload.mode === 'SUMMARY' ? payload.summaryText : null,
        indexStatus: 'NONE',
        chunkCount: 0,
        signatureId: agreement.signatureId ?? 'sig_new',
        createdAt: '2026-11-17T05:10:00.000Z',
        updatedAt: '2026-11-17T05:10:00.000Z',
      };
      items = [created, ...items];
      return created;
    },
    async update(id, payload) {
      const target = items.find((i) => i.id === id)!;
      return { ...target, name: payload.name };
    },
    async bulkDelete(ids) {
      items = items.filter((i) => !ids.includes(i.id));
      return { deleted: ids.length };
    },
    async getAgreementStatus() {
      return agreement;
    },
    async signAgreement() {
      signCalls += 1;
      agreement = {
        kind: KB_AGREEMENT_KIND,
        version: KB_AGREEMENT_VERSION,
        signed: true,
        signatureId: `sig_${signCalls}`,
        signedAt: '2026-11-17T05:05:00.000Z',
      };
      return agreement;
    },
    async download() {
      return { filename: 'kb.csv', mime: 'text/csv', body: new Uint8Array() };
    },
  };

  return { gateway, createdPayloads, getSignCalls: () => signCalls };
}

describe('KnowledgeScreen', () => {
  it('renders exact 5 columns without 序号, shows companyName only for DETAIL, and disables toolbar delete until selected', async () => {
    const { gateway } = makeGateway({ signed: true });
    render(<KnowledgeScreen title="企业知识库" gateway={gateway} />);

    await waitFor(() => {
      expect(document.body.textContent).toContain('激光装备产品库');
    });

    const headers = Array.from(document.querySelectorAll('thead th'))
      .map((th) => (th.textContent ?? '').trim())
      .filter((txt) => txt.length > 0);
    expect(headers).toEqual(['名称', '类型', '公司名', '创建时间', '操作']);

    expect(document.body.textContent).toContain('苏州智造装备有限公司');
    expect(document.body.textContent).toContain('细分模式');
    expect(document.body.textContent).toContain('汇总模式');
    expect(document.body.textContent).toContain('可用');

    // Summary row cell for companyName is empty
    const rows = Array.from(document.querySelectorAll('tbody tr'));
    const summaryRow = rows.find((tr) => (tr.textContent ?? '').includes('两万字工艺总览'));
    expect(summaryRow).toBeTruthy();
    const summaryCells = Array.from(summaryRow!.querySelectorAll('td'));
    // td[0]=checkbox, td[1]=名称, td[2]=类型, td[3]=公司名
    expect(summaryCells[3]?.textContent?.trim()).toBe('');

    const toolbarDelete = document.querySelector('button[aria-label="删除"]') as HTMLButtonElement;
    expect(toolbarDelete.disabled).toBe(true);
  });

  it('preserves DETAIL & SUMMARY drafts independently when switching modes, shows 查看说明 on exact 5 fields, blocks unsigned save, and unlocks agreement after scrolling to bottom', async () => {
    const { gateway, createdPayloads, getSignCalls } = makeGateway({ signed: false });
    render(<KnowledgeScreen title="企业知识库" gateway={gateway} />);

    await waitFor(() => {
      expect(document.body.textContent).toContain('激光装备产品库');
    });

    clickBtn('添加');

    // Only exact 5 fields have 查看说明; 品牌故事 and 其他信息 do NOT
    expect(document.querySelector('button[aria-label="查看说明-产品服务"]')).toBeTruthy();
    expect(document.querySelector('button[aria-label="查看说明-产品特点"]')).toBeTruthy();
    expect(document.querySelector('button[aria-label="查看说明-用户痛点"]')).toBeTruthy();
    expect(document.querySelector('button[aria-label="查看说明-信任背书"]')).toBeTruthy();
    expect(document.querySelector('button[aria-label="查看说明-客户案例"]')).toBeTruthy();
    expect(document.querySelector('button[aria-label="查看说明-品牌故事"]')).toBeNull();
    expect(document.querySelector('button[aria-label="查看说明-其他信息"]')).toBeNull();

    // Open 查看说明 preview modal
    fireEvent.click(document.querySelector('button[aria-label="查看说明-产品服务"]')!);
    expect(document.body.textContent).toContain('预览');
    expect(document.body.textContent).toContain('内容：');
    expect(document.body.textContent).toContain('说明：');
    expect(document.body.textContent).toContain('实例：');
    clickBtn('知道了');

    // Fill shared name + DETAIL fields
    const nameInput = document.querySelector('input[aria-label="知识库名称"]') as HTMLInputElement;
    const companyInput = document.querySelector('input[aria-label="公司名称"]') as HTMLInputElement;
    const brandInput = document.querySelector('input[aria-label="品牌简称"]') as HTMLInputElement;
    const serviceArea = document.querySelector(
      'textarea[aria-label="产品服务"]',
    ) as HTMLTextAreaElement;

    fireEvent.change(nameInput, { target: { value: '智能制造通用库' } });
    fireEvent.change(companyInput, { target: { value: '无锡精密装备有限公司' } });
    fireEvent.change(brandInput, { target: { value: '锡精机' } });
    fireEvent.change(serviceArea, { target: { value: '主营精密数控折弯单元' } });

    // Switch to SUMMARY mode -> fill summary -> switch back to DETAIL -> switch back to SUMMARY
    const summaryRadio = Array.from(document.querySelectorAll('input[type="radio"]')).find(
      (el) => (el as HTMLInputElement).value === 'SUMMARY',
    )!;
    fireEvent.click(summaryRadio);

    expect(document.querySelector('input[aria-label="公司名称"]')).toBeNull();
    expect(
      (document.querySelector('input[aria-label="知识库名称"]') as HTMLInputElement).value,
    ).toBe('智能制造通用库');

    const summaryArea = document.querySelector(
      'textarea[aria-label="汇总信息"]',
    ) as HTMLTextAreaElement;
    fireEvent.change(summaryArea, {
      target: { value: '本企业汇总资料：提供钣金柔性折弯中心与产线集成交付。' },
    });

    const detailRadio = Array.from(document.querySelectorAll('input[type="radio"]')).find(
      (el) => (el as HTMLInputElement).value === 'DETAIL',
    )!;
    fireEvent.click(detailRadio);

    // Detail draft is completely intact and NOT overwritten by summary
    expect((document.querySelector('input[aria-label="公司名称"]') as HTMLInputElement).value).toBe(
      '无锡精密装备有限公司',
    );
    expect(
      (document.querySelector('textarea[aria-label="产品服务"]') as HTMLTextAreaElement).value,
    ).toBe('主营精密数控折弯单元');

    // Switch back to SUMMARY to submit summary while keeping name shared
    fireEvent.click(summaryRadio);
    expect(
      (document.querySelector('textarea[aria-label="汇总信息"]') as HTMLTextAreaElement).value,
    ).toBe('本企业汇总资料：提供钣金柔性折弯中心与产线集成交付。');

    // Attempt to save while unsigned -> blocked, error shown, agreement modal opens
    await act(async () => {
      clickBtn('确定');
    });
    expect(createdPayloads).toHaveLength(0);
    expect(document.body.textContent).toContain(KB_UNSIGNED_ERROR_MSG);

    const scrollBox = document.querySelector('[data-testid="kb-agreement-scroll"]') as HTMLElement;
    expect(scrollBox).toBeTruthy();

    const confirmSignBtn = findBtn(KB_AGREEMENT_CONFIRM_BUTTON_LABEL)!;
    expect(confirmSignBtn.disabled).toBe(true);

    // Before scrolling to bottom, checkbox is disabled
    const modalCheckboxes = Array.from(
      document.querySelectorAll('.ant-modal input[type="checkbox"]'),
    ) as HTMLInputElement[];
    const agreeCheckbox = modalCheckboxes[modalCheckboxes.length - 1]!;
    expect(agreeCheckbox.disabled).toBe(true);

    // Simulate scrolling halfway -> still locked
    Object.defineProperty(scrollBox, 'scrollHeight', { value: 600, configurable: true });
    Object.defineProperty(scrollBox, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(scrollBox, 'scrollTop', { value: 150, configurable: true });
    fireEvent.scroll(scrollBox);
    expect(agreeCheckbox.disabled).toBe(true);

    // Scroll to bottom -> checkbox unlocks!
    Object.defineProperty(scrollBox, 'scrollTop', { value: 396, configurable: true });
    fireEvent.scroll(scrollBox);
    expect(agreeCheckbox.disabled).toBe(false);
    expect(confirmSignBtn.disabled).toBe(true);

    // Check agreement box -> confirm button unlocks!
    fireEvent.click(agreeCheckbox);
    expect(confirmSignBtn.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(confirmSignBtn);
    });
    expect(getSignCalls()).toBe(1);

    // Draft is preserved after signing; clicking 确定 now saves!
    expect(
      (document.querySelector('textarea[aria-label="汇总信息"]') as HTMLTextAreaElement).value,
    ).toBe('本企业汇总资料：提供钣金柔性折弯中心与产线集成交付。');

    await act(async () => {
      clickBtn('确定');
    });

    await waitFor(() => {
      expect(createdPayloads).toHaveLength(1);
    });
    expect(createdPayloads[0]).toEqual({
      name: '智能制造通用库',
      mode: 'SUMMARY',
      summaryText: '本企业汇总资料：提供钣金柔性折弯中心与产线集成交付。',
    });
  });
});
