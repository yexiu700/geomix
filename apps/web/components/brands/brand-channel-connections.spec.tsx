// @vitest-environment jsdom

import type { ChannelConnectionDto, ChannelConnectionTestResultDto } from '@geomix/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayApiError } from '../../lib/envelope';
import * as studioLib from '../../lib/studio';
import { invalidateFreshness, resetFreshnessForTests } from '../../lib/tab-freshness';
import { BrandChannelConnections } from './brand-channel-connections';

const listChannelConnectionsMock = vi.fn();
const createChannelConnectionMock = vi.fn();
const updateChannelConnectionMock = vi.fn();
const deleteChannelConnectionMock = vi.fn();
const testChannelConnectionMock = vi.fn();
const startShopifyOAuthMock = vi.fn();

vi.mock('../../lib/distribution', () => ({
  listChannelConnections: (...args: unknown[]) => listChannelConnectionsMock(...args),
  createChannelConnection: (...args: unknown[]) => createChannelConnectionMock(...args),
  updateChannelConnection: (...args: unknown[]) => updateChannelConnectionMock(...args),
  deleteChannelConnection: (...args: unknown[]) => deleteChannelConnectionMock(...args),
  testChannelConnection: (...args: unknown[]) => testChannelConnectionMock(...args),
  startShopifyOAuth: (...args: unknown[]) => startShopifyOAuthMock(...args),
}));

const confirmMock = vi.fn();
const notifySuccessMock = vi.fn();
const notifyWarningMock = vi.fn();
const notifyErrorMock = vi.fn();

vi.mock('../crud/ux-feedback', () => ({
  useUxFeedback: () => ({
    confirm: confirmMock,
    notifySuccess: notifySuccessMock,
    notifyWarning: notifyWarningMock,
    notifyError: notifyErrorMock,
  }),
}));

function makeConn(overrides: Partial<ChannelConnectionDto> = {}): ChannelConnectionDto {
  return {
    id: 'conn_1',
    brandId: 'brand_1',
    brandMarketId: 'bm_gl_1',
    market: 'GLOBAL',
    provider: 'SHOPIFY',
    displayName: 'Official Shopify Blog',
    siteBaseUrl: 'https://store.example.com',
    credentialHint: 'shpat_****9a2f',
    configJson: {
      blogId: 'gid://shopify/Blog/101',
      blogHandle: 'news',
      defaultPublishAsDraft: true,
      inlineJsonLd: true,
      indexNowKey: 'idxkey12345678',
    },
    status: 'ACTIVE',
    authType: 'API_KEY',
    lastTestedAt: '2026-11-22T02:00:00.000Z',
    lastError: null,
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-22T02:00:00.000Z',
    ...overrides,
  };
}

async function selectAntdOption(selectWrapper: HTMLElement, optionLabel: string) {
  const combobox =
    selectWrapper.querySelector('input[role="combobox"]') ??
    within(selectWrapper).getByRole('combobox');
  fireEvent.mouseDown(combobox);
  const option = await screen.findByTitle(optionLabel);
  fireEvent.click(option);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetFreshnessForTests();
  listChannelConnectionsMock.mockResolvedValue({ items: [] });
});

afterEach(async () => {
  cleanup();
  resetFreshnessForTests();
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  vi.restoreAllMocks();
});

describe('BrandChannelConnections (/brands market-scoped L1 channels)', () => {
  it('shows enable-market prompt when marketEnabled is false and invokes onEnableMarket', () => {
    const onEnableMarket = vi.fn();
    render(
      <BrandChannelConnections
        brandId="brand_1"
        activeMarket="GLOBAL"
        marketEnabled={false}
        readOnly={false}
        onEnableMarket={onEnableMarket}
      />,
    );

    expect(screen.getByText('当前市场尚未开启')).toBeTruthy();
    expect(listChannelConnectionsMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '立即开启' }));
    expect(onEnableMarket).toHaveBeenCalledTimes(1);
  });

  it('creates Shopify connection with save-and-test target discovery, clears plaintext secrets on close, and preserves blank credentials on PATCH', async () => {
    const created = makeConn({
      id: 'conn_shopify_new',
      displayName: 'AstraVault Shopify',
      siteBaseUrl: 'https://astravault.myshopify.com',
      credentialHint: 'shpat_****4455',
      configJson: { defaultPublishAsDraft: true, inlineJsonLd: true },
    });
    createChannelConnectionMock.mockResolvedValueOnce(created);
    testChannelConnectionMock.mockResolvedValueOnce({
      ok: true,
      status: 'ACTIVE',
      message: '已连接 Shopify 店铺，发现 2 个博客',
      testedAt: '2026-11-23T06:00:00.000Z',
      targets: [
        { id: 'gid://shopify/Blog/201', name: 'Engineering Blog', handle: 'engineering' },
        { id: 'gid://shopify/Blog/202', name: 'News', handle: 'news' },
      ],
    } satisfies ChannelConnectionTestResultDto);
    updateChannelConnectionMock.mockResolvedValueOnce({
      ...created,
      displayName: 'AstraVault Shopify Updated',
      configJson: {
        blogId: 'gid://shopify/Blog/201',
        blogHandle: 'engineering',
        defaultPublishAsDraft: true,
        inlineJsonLd: true,
      },
    });

    render(
      <BrandChannelConnections
        brandId="brand_1"
        activeMarket="GLOBAL"
        marketEnabled={true}
        readOnly={false}
        onEnableMarket={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(listChannelConnectionsMock).toHaveBeenCalledWith(
        'brand_1',
        'GLOBAL',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    fireEvent.click(screen.getByTestId('add-channel-connection-btn'));
    const modal = await screen.findByTestId('channel-connection-modal');
    fireEvent.click(within(modal).getByRole('tab', { name: /Custom App Token/ }));

    fireEvent.change(within(modal).getByLabelText('连接名称'), {
      target: { value: 'AstraVault Shopify' },
    });
    fireEvent.change(within(modal).getByLabelText('站点地址'), {
      target: { value: 'https://astravault.myshopify.com' },
    });
    fireEvent.change(within(modal).getByLabelText('Shopify Access Token'), {
      target: { value: 'shpat_super_secret_plaintext_4455' },
    });

    // Save & Test pulls blog targets and transitions modal into edit mode while wiping raw secret input
    fireEvent.click(screen.getByTestId('channel-connection-save-and-test-btn'));
    await waitFor(() => {
      expect(createChannelConnectionMock).toHaveBeenCalledWith(
        'brand_1',
        expect.objectContaining({
          market: 'GLOBAL',
          provider: 'SHOPIFY',
          displayName: 'AstraVault Shopify',
          siteBaseUrl: 'https://astravault.myshopify.com',
          credentials: { accessToken: 'shpat_super_secret_plaintext_4455' },
          configJson: { defaultPublishAsDraft: true, inlineJsonLd: true },
        }),
        expect.anything(),
      );
      expect(testChannelConnectionMock).toHaveBeenCalledWith(
        'brand_1',
        'conn_shopify_new',
        {},
        expect.anything(),
      );
    });

    // Plaintext secret is wiped after create+test and target blogId auto-populated
    await waitFor(() => {
      expect((within(modal).getByLabelText('Shopify Access Token') as HTMLInputElement).value).toBe(
        '',
      );
      expect((within(modal).getByLabelText('Shopify Blog ID') as HTMLInputElement).value).toBe(
        'gid://shopify/Blog/201',
      );
    });

    // Edit displayName without entering secret -> PATCH omits credentials completely
    fireEvent.change(within(modal).getByLabelText('连接名称'), {
      target: { value: 'AstraVault Shopify Updated' },
    });
    fireEvent.click(screen.getByTestId('channel-connection-submit-btn'));

    await waitFor(() => {
      expect(updateChannelConnectionMock).toHaveBeenCalledTimes(1);
    });
    const patchPayload = updateChannelConnectionMock.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(patchPayload).not.toHaveProperty('credentials');
    expect(patchPayload.displayName).toBe('AstraVault Shopify Updated');
    expect(patchPayload.configJson).toEqual(
      expect.objectContaining({
        blogId: 'gid://shopify/Blog/201',
        blogHandle: 'engineering',
      }),
    );

    // Card renders displayName + masked credentialHint, ZERO plaintext secret in DOM
    await waitFor(() => {
      expect(screen.getByTestId('channel-connection-card-conn_shopify_new')).toBeTruthy();
    });
    expect(document.body.textContent).toContain('shpat_****4455');
    expect(document.body.textContent).not.toContain('shpat_super_secret_plaintext_4455');
  });

  it('supports WordPress with numeric categoryIds conversion and Webflow cascading collection fieldMap', async () => {
    const wpConn = makeConn({
      id: 'conn_wp_1',
      provider: 'WORDPRESS',
      displayName: 'Corporate WP Blog',
      siteBaseUrl: 'https://blog.astravault.example',
      credentialHint: 'edit****abcd',
      configJson: { categoryIds: [12], defaultPublishAsDraft: true, inlineJsonLd: true },
    });
    const wfConn = makeConn({
      id: 'conn_wf_1',
      provider: 'WEBFLOW',
      displayName: 'Webflow Guides',
      siteBaseUrl: 'https://www.astravault.example',
      credentialHint: 'wf_****8899',
      configJson: {
        siteId: 'site_1',
        collectionId: 'col_1',
        collectionSlug: 'guides',
        fieldMap: { title: 'name', slug: 'slug', bodyHtml: 'post-body' },
        defaultPublishAsDraft: true,
        inlineJsonLd: true,
      },
    });
    listChannelConnectionsMock.mockResolvedValueOnce({ items: [wpConn, wfConn] });

    // WordPress test returns string category IDs; UI converts them to number[]
    testChannelConnectionMock.mockResolvedValueOnce({
      ok: true,
      status: 'ACTIVE',
      message: 'WordPress 连通正常',
      testedAt: '2026-11-23T06:05:00.000Z',
      targets: [
        { id: '12', name: 'Hardware Reviews', handle: 'hardware' },
        { id: '25', name: 'GEO Guides', handle: 'geo-guides' },
      ],
    });
    updateChannelConnectionMock.mockResolvedValueOnce({
      ...wpConn,
      configJson: { categoryIds: [12, 25], defaultPublishAsDraft: true, inlineJsonLd: true },
    });

    render(
      <BrandChannelConnections
        brandId="brand_1"
        activeMarket="GLOBAL"
        marketEnabled={true}
        readOnly={false}
        onEnableMarket={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('channel-connection-card-conn_wp_1')).toBeTruthy();
      expect(screen.getByTestId('channel-connection-card-conn_wf_1')).toBeTruthy();
    });

    // Edit WordPress, test to fetch categories, select category 25, save
    fireEvent.click(screen.getByTestId('channel-connection-edit-btn-conn_wp_1'));
    const wpModal = await screen.findByTestId('channel-connection-modal');
    fireEvent.click(screen.getByTestId('channel-connection-modal-test-btn'));
    await waitFor(() => {
      expect(testChannelConnectionMock).toHaveBeenCalledWith(
        'brand_1',
        'conn_wp_1',
        {},
        expect.anything(),
      );
    });

    const catSelect = within(wpModal).getByRole('combobox', { name: 'WordPress 默认分类' });
    fireEvent.mouseDown(catSelect);
    const geoGuidesOpt = await screen.findByTitle('GEO Guides (geo-guides)');
    fireEvent.click(geoGuidesOpt);

    fireEvent.click(screen.getByTestId('channel-connection-submit-btn'));
    await waitFor(() => {
      expect(updateChannelConnectionMock).toHaveBeenCalledWith(
        'brand_1',
        'conn_wp_1',
        expect.objectContaining({
          configJson: expect.objectContaining({
            categoryIds: [12, 25],
          }),
        }),
        expect.anything(),
      );
    });

    // Edit Webflow, test to fetch collections + fields, switch collection triggers cascading re-test
    testChannelConnectionMock
      .mockResolvedValueOnce({
        ok: true,
        status: 'ACTIVE',
        message: '已拉取 Webflow 集合与字段',
        testedAt: '2026-11-23T06:06:00.000Z',
        targets: [
          {
            id: 'col_1',
            name: 'Guides',
            handle: 'guides',
            meta: {
              siteId: 'site_1',
              collectionSlug: 'guides',
              fields: [
                { id: 'f1', slug: 'name', displayName: 'Title' },
                { id: 'f2', slug: 'slug', displayName: 'Slug' },
                { id: 'f3', slug: 'post-body', displayName: 'Body' },
                { id: 'f4', slug: 'meta-summary', displayName: 'Meta Summary' },
              ],
            },
          },
          {
            id: 'col_2',
            name: 'Benchmarks',
            handle: 'benchmarks',
            meta: {
              siteId: 'site_1',
              collectionSlug: 'benchmarks',
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 'ACTIVE',
        message: '已拉取 Benchmarks 字段',
        testedAt: '2026-11-23T06:07:00.000Z',
        targets: [
          {
            id: 'col_1',
            name: 'Guides',
            handle: 'guides',
            meta: {
              siteId: 'site_1',
              collectionSlug: 'guides',
            },
          },
          {
            id: 'col_2',
            name: 'Benchmarks',
            handle: 'benchmarks',
            meta: {
              siteId: 'site_1',
              collectionSlug: 'benchmarks',
              fields: [
                { id: 'bf1', slug: 'bench-title', displayName: 'Bench Title' },
                { id: 'bf2', slug: 'bench-body', displayName: 'Bench Body' },
              ],
            },
          },
        ],
      });
    updateChannelConnectionMock.mockResolvedValueOnce({
      ...wfConn,
      configJson: {
        ...wfConn.configJson,
        collectionId: 'col_2',
        collectionSlug: 'benchmarks',
      },
    });

    fireEvent.click(screen.getByTestId('channel-connection-edit-btn-conn_wf_1'));
    const wfModal = await screen.findByTestId('channel-connection-modal');
    fireEvent.click(screen.getByTestId('channel-connection-modal-test-btn'));
    await waitFor(() => {
      expect(testChannelConnectionMock).toHaveBeenCalledWith(
        'brand_1',
        'conn_wf_1',
        { siteId: 'site_1', collectionId: 'col_1' },
        expect.anything(),
      );
    });

    // Switch collection to col_2 -> cascades testChannelConnection with collectionId: 'col_2'
    const colSelect = within(wfModal).getByRole('combobox', { name: 'Webflow Collection 选择' });
    fireEvent.mouseDown(colSelect);
    const col2Opt = await screen.findByTitle('Benchmarks (benchmarks)');
    fireEvent.click(col2Opt);

    await waitFor(() => {
      expect(testChannelConnectionMock).toHaveBeenCalledWith(
        'brand_1',
        'conn_wf_1',
        { siteId: 'site_1', collectionId: 'col_2' },
        expect.anything(),
      );
    });

    // Saving preserves col_2 AND collectionSlug: 'benchmarks' even though backend returned [col_1, col_2]
    fireEvent.click(screen.getByTestId('channel-connection-submit-btn'));
    await waitFor(() => {
      expect(updateChannelConnectionMock).toHaveBeenLastCalledWith(
        'brand_1',
        'conn_wf_1',
        expect.objectContaining({
          configJson: expect.objectContaining({
            siteId: 'site_1',
            collectionId: 'col_2',
            collectionSlug: 'benchmarks',
          }),
        }),
        expect.anything(),
      );
    });
  });

  it('supports Webhook random signing secret generation, one-time copy, and displays SSRF 400 rejection error', async () => {
    const copySpy = vi.spyOn(studioLib, 'copyTextToClipboard').mockResolvedValue(true);
    createChannelConnectionMock.mockRejectedValueOnce(
      new GatewayApiError(400, 40001, '站点地址不允许访问（禁止内网、回环或保留地址）'),
    );

    render(
      <BrandChannelConnections
        brandId="brand_1"
        activeMarket="GLOBAL"
        marketEnabled={true}
        readOnly={false}
        onEnableMarket={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(listChannelConnectionsMock).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByTestId('add-channel-connection-btn'));
    const modal = await screen.findByTestId('channel-connection-modal');

    await selectAntdOption(
      within(modal).getByTestId('channel-provider-select'),
      '通用签名 Webhook',
    );

    fireEvent.change(within(modal).getByLabelText('连接名称'), {
      target: { value: 'Internal SSRF Hook' },
    });
    fireEvent.change(within(modal).getByLabelText('站点地址'), {
      target: { value: 'http://127.0.0.1:8080/hook' },
    });

    // Generate random secret & copy it
    fireEvent.click(within(modal).getByTestId('webhook-generate-secret-btn'));
    const secretInput = within(modal).getByLabelText('Webhook 签名密钥') as HTMLInputElement;
    expect(secretInput.value.length).toBe(32);

    fireEvent.click(within(modal).getByTestId('webhook-copy-secret-btn'));
    await waitFor(() => {
      expect(copySpy).toHaveBeenCalledWith(secretInput.value);
    });

    // Submit -> server returns 400 SSRF error -> shown prominently in modal Alert
    fireEvent.click(screen.getByTestId('channel-connection-submit-btn'));
    await waitFor(() => {
      expect(within(modal).getByRole('alert').textContent).toContain(
        '站点地址不允许访问（禁止内网、回环或保留地址）',
      );
    });
  });

  it('handles HTTP 200 ok:false INVALID test status, deletes via useUxFeedback().confirm, and isolates market switch', async () => {
    const conn = makeConn({ id: 'conn_test_1', displayName: 'Global Blog' });
    listChannelConnectionsMock
      .mockResolvedValueOnce({ items: [conn] })
      .mockResolvedValueOnce({ items: [] });

    testChannelConnectionMock.mockResolvedValueOnce({
      ok: false,
      status: 'INVALID',
      message: '鉴权失败：Access Token 已失效',
      testedAt: '2026-11-23T06:10:00.000Z',
    });
    deleteChannelConnectionMock.mockResolvedValueOnce({ deleted: 1, id: 'conn_test_1' });
    confirmMock.mockImplementationOnce(({ onOk }: { onOk?: () => Promise<void> | void }) => {
      void onOk?.();
    });

    const { rerender } = render(
      <BrandChannelConnections
        brandId="brand_1"
        activeMarket="GLOBAL"
        marketEnabled={true}
        readOnly={false}
        onEnableMarket={vi.fn()}
      />,
    );

    const card = await screen.findByTestId('channel-connection-card-conn_test_1');
    expect(within(card).getByText('已连接')).toBeTruthy();

    // Test card -> ok: false updates badge to 连接异常 and renders lastError
    fireEvent.click(screen.getByTestId('channel-connection-test-btn-conn_test_1'));
    await waitFor(() => {
      expect(within(card).getByText('连接异常')).toBeTruthy();
      expect(within(card).getByText('鉴权失败：Access Token 已失效')).toBeTruthy();
      expect(notifyErrorMock).toHaveBeenCalledWith('鉴权失败：Access Token 已失效');
    });

    // Delete via useUxFeedback().confirm
    fireEvent.click(screen.getByTestId('channel-connection-delete-btn-conn_test_1'));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(deleteChannelConnectionMock).toHaveBeenCalledWith(
        'brand_1',
        'conn_test_1',
        expect.anything(),
      );
      expect(screen.queryByTestId('channel-connection-card-conn_test_1')).toBeNull();
    });

    // Switch market GLOBAL -> CN triggers fresh scoped listChannelConnections('brand_1', 'CN')
    rerender(
      <BrandChannelConnections
        brandId="brand_1"
        activeMarket="CN"
        marketEnabled={true}
        readOnly={false}
        onEnableMarket={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(listChannelConnectionsMock).toHaveBeenCalledWith(
        'brand_1',
        'CN',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });

  it('disables card & modal test/edit/delete/add buttons when readOnly is true and clears stale Shopify blogHandle on manual blogId edit', async () => {
    const conn = makeConn({
      id: 'conn_ro_1',
      displayName: 'Expired Tenant Store',
      configJson: {
        blogId: 'gid://shopify/Blog/101',
        blogHandle: 'news',
        defaultPublishAsDraft: true,
        inlineJsonLd: true,
      },
    });
    listChannelConnectionsMock.mockResolvedValue({ items: [conn] });
    updateChannelConnectionMock.mockResolvedValueOnce({
      ...conn,
      configJson: {
        blogId: 'gid://shopify/Blog/999',
        defaultPublishAsDraft: true,
        inlineJsonLd: true,
      },
    });

    const { rerender } = render(
      <BrandChannelConnections
        brandId="brand_1"
        activeMarket="GLOBAL"
        marketEnabled={true}
        readOnly={false}
        onEnableMarket={vi.fn()}
      />,
    );

    await screen.findByTestId('channel-connection-card-conn_ro_1');

    // Manual Shopify blogId edit clears stale blogHandle before save
    fireEvent.click(screen.getByTestId('channel-connection-edit-btn-conn_ro_1'));
    const editModal = await screen.findByTestId('channel-connection-modal');
    fireEvent.change(within(editModal).getByLabelText('Shopify Blog ID'), {
      target: { value: 'gid://shopify/Blog/999' },
    });
    fireEvent.click(screen.getByTestId('channel-connection-submit-btn'));
    await waitFor(() => {
      expect(updateChannelConnectionMock).toHaveBeenCalledTimes(1);
    });
    const savedConfig = (
      updateChannelConnectionMock.mock.calls[0]?.[2] as { configJson?: Record<string, unknown> }
    )?.configJson;
    expect(savedConfig?.blogId).toBe('gid://shopify/Blog/999');
    expect(savedConfig).not.toHaveProperty('blogHandle');

    // Open edit modal then flip readOnly=true -> modal test button & card actions all disabled
    fireEvent.click(screen.getByTestId('channel-connection-edit-btn-conn_ro_1'));
    await screen.findByTestId('channel-connection-modal');
    rerender(
      <BrandChannelConnections
        brandId="brand_1"
        activeMarket="GLOBAL"
        marketEnabled={true}
        readOnly={true}
        onEnableMarket={vi.fn()}
      />,
    );

    const modalTestBtn = screen.getByTestId(
      'channel-connection-modal-test-btn',
    ) as HTMLButtonElement;
    expect(modalTestBtn.disabled).toBe(true);
    fireEvent.click(modalTestBtn);

    const addBtn = screen.getByTestId('add-channel-connection-btn') as HTMLButtonElement;
    const testBtn = screen.getByTestId(
      'channel-connection-test-btn-conn_ro_1',
    ) as HTMLButtonElement;
    const editBtn = screen.getByTestId(
      'channel-connection-edit-btn-conn_ro_1',
    ) as HTMLButtonElement;
    const deleteBtn = screen.getByTestId(
      'channel-connection-delete-btn-conn_ro_1',
    ) as HTMLButtonElement;

    expect(addBtn.disabled).toBe(true);
    expect(testBtn.disabled).toBe(true);
    expect(editBtn.disabled).toBe(true);
    expect(deleteBtn.disabled).toBe(true);

    fireEvent.click(testBtn);
    expect(testChannelConnectionMock).not.toHaveBeenCalled();
  });

  it('aborts in-flight handleTestCard on unmount/brand switch and ignores stale handleDeleteCard confirm after brand switch', async () => {
    const connA = makeConn({ id: 'conn_a_1', brandId: 'brand_a', displayName: 'Brand A Store' });
    listChannelConnectionsMock
      .mockResolvedValueOnce({ items: [connA] })
      .mockResolvedValueOnce({ items: [] });

    let resolveTest!: (v: ChannelConnectionTestResultDto) => void;
    let capturedSignal: AbortSignal | undefined;
    testChannelConnectionMock.mockImplementationOnce(
      (_brandId: string, _connId: string, _input: unknown, opts?: { signal?: AbortSignal }) => {
        capturedSignal = opts?.signal;
        return new Promise<ChannelConnectionTestResultDto>((resolve) => {
          resolveTest = resolve;
        });
      },
    );

    let capturedDeleteOnOk: (() => Promise<void> | void) | undefined;
    confirmMock.mockImplementationOnce(({ onOk }: { onOk?: () => Promise<void> | void }) => {
      capturedDeleteOnOk = onOk;
    });

    const { rerender, unmount } = render(
      <BrandChannelConnections
        brandId="brand_a"
        activeMarket="GLOBAL"
        marketEnabled={true}
        readOnly={false}
        onEnableMarket={vi.fn()}
      />,
    );

    await screen.findByTestId('channel-connection-card-conn_a_1');

    // Start card test and open delete confirm on Brand A
    fireEvent.click(screen.getByTestId('channel-connection-test-btn-conn_a_1'));
    fireEvent.click(screen.getByTestId('channel-connection-delete-btn-conn_a_1'));
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(false);
    expect(capturedDeleteOnOk).toBeTypeOf('function');

    // Switch brand to brand_b before either completes
    rerender(
      <BrandChannelConnections
        brandId="brand_b"
        activeMarket="GLOBAL"
        marketEnabled={true}
        readOnly={false}
        onEnableMarket={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(listChannelConnectionsMock).toHaveBeenCalledWith(
        'brand_b',
        'GLOBAL',
        expect.anything(),
      );
    });
    expect(capturedSignal?.aborted).toBe(true);

    // Late test resolution & late confirm onOk MUST NOT fire stale toasts or delete Brand A
    await act(async () => {
      resolveTest({
        ok: true,
        status: 'ACTIVE',
        message: 'BRAND_A_STALE_TEST_OK',
        testedAt: '2026-11-23T06:30:00.000Z',
      });
      await capturedDeleteOnOk?.();
    });

    expect(notifySuccessMock).not.toHaveBeenCalled();
    expect(notifyErrorMock).not.toHaveBeenCalled();
    expect(deleteChannelConnectionMock).not.toHaveBeenCalled();

    // Unmount guard also aborts an in-flight test on brand_b
    const connB = makeConn({ id: 'conn_b_1', brandId: 'brand_b', displayName: 'Brand B Store' });
    listChannelConnectionsMock.mockResolvedValueOnce({ items: [connB] });
    rerender(
      <BrandChannelConnections
        brandId="brand_b"
        activeMarket="CN"
        marketEnabled={true}
        readOnly={false}
        onEnableMarket={vi.fn()}
      />,
    );
    await screen.findByTestId('channel-connection-card-conn_b_1');

    let resolveUnmountTest!: (v: ChannelConnectionTestResultDto) => void;
    let unmountSignal: AbortSignal | undefined;
    testChannelConnectionMock.mockImplementationOnce(
      (_brandId: string, _connId: string, _input: unknown, opts?: { signal?: AbortSignal }) => {
        unmountSignal = opts?.signal;
        return new Promise<ChannelConnectionTestResultDto>((resolve) => {
          resolveUnmountTest = resolve;
        });
      },
    );
    fireEvent.click(screen.getByTestId('channel-connection-test-btn-conn_b_1'));
    expect(unmountSignal?.aborted).toBe(false);

    unmount();
    expect(unmountSignal?.aborted).toBe(true);

    await act(async () => {
      resolveUnmountTest({
        ok: true,
        status: 'ACTIVE',
        message: 'UNMOUNTED_STALE_OK',
        testedAt: '2026-11-23T06:31:00.000Z',
      });
    });
    expect(notifySuccessMock).not.toHaveBeenCalled();
    expect(notifyErrorMock).not.toHaveBeenCalled();
  });

  it('completes handleTestCard and handleDeleteCard cleanly when same-brand invalidateFreshness refreshes the list', async () => {
    const connTest = makeConn({
      id: 'conn_fresh_1',
      brandId: 'brand_a',
      displayName: 'Freshness Test Store',
    });
    const connDel = makeConn({
      id: 'conn_fresh_del',
      brandId: 'brand_a',
      displayName: 'Freshness Delete Store',
    });
    listChannelConnectionsMock.mockResolvedValue({ items: [connTest, connDel] });

    let resolveTest!: (v: ChannelConnectionTestResultDto) => void;
    testChannelConnectionMock.mockImplementationOnce(
      () =>
        new Promise<ChannelConnectionTestResultDto>((resolve) => {
          resolveTest = resolve;
        }),
    );

    let capturedDeleteOnOk: (() => Promise<void> | void) | undefined;
    confirmMock.mockImplementationOnce(({ onOk }: { onOk?: () => Promise<void> | void }) => {
      capturedDeleteOnOk = onOk;
    });
    deleteChannelConnectionMock.mockResolvedValueOnce({ deleted: 1, id: 'conn_fresh_del' });

    render(
      <BrandChannelConnections
        brandId="brand_a"
        activeMarket="GLOBAL"
        marketEnabled={true}
        readOnly={false}
        onEnableMarket={vi.fn()}
      />,
    );

    await screen.findByTestId('channel-connection-card-conn_fresh_1');
    expect(listChannelConnectionsMock).toHaveBeenCalledTimes(1);

    // 1. Start handleTestCard and open handleDeleteCard confirm modal
    const testBtn = screen.getByTestId('channel-connection-test-btn-conn_fresh_1');
    fireEvent.click(testBtn);
    expect(testBtn.classList.contains('ant-btn-loading')).toBe(true);

    fireEvent.click(screen.getByTestId('channel-connection-delete-btn-conn_fresh_del'));
    expect(capturedDeleteOnOk).toBeTypeOf('function');

    // 2. Trigger same-brand silent freshness refresh while both are active (bumps loadSeqRef)
    await act(async () => {
      invalidateFreshness('channel-connections');
    });
    await waitFor(() => {
      expect(listChannelConnectionsMock).toHaveBeenCalledTimes(2);
    });

    // 3. Resolve in-flight handleTestCard -> loading spinner MUST reset and success toast MUST fire
    await act(async () => {
      resolveTest({
        ok: true,
        status: 'ACTIVE',
        message: 'SAME_BRAND_TEST_OK',
        testedAt: '2026-11-23T06:40:00.000Z',
      });
    });

    await waitFor(() => {
      expect(
        screen
          .getByTestId('channel-connection-test-btn-conn_fresh_1')
          .classList.contains('ant-btn-loading'),
      ).toBe(false);
    });
    expect(notifySuccessMock).toHaveBeenCalledWith('SAME_BRAND_TEST_OK');

    // 4. Invoke open confirm onOk() -> deleteChannelConnection MUST still execute cleanly
    await act(async () => {
      await capturedDeleteOnOk?.();
    });

    await waitFor(() => {
      expect(deleteChannelConnectionMock).toHaveBeenCalledWith(
        'brand_a',
        'conn_fresh_del',
        expect.anything(),
      );
      expect(screen.queryByTestId('channel-connection-card-conn_fresh_del')).toBeNull();
    });
    expect(notifySuccessMock).toHaveBeenCalledWith('已删除渠道连接「Freshness Delete Store」');
  });

  it('completes runModalTest and handleModalSubmit cleanly without deadlocking buttons when same-brand invalidateFreshness fires', async () => {
    const conn = makeConn({
      id: 'conn_modal_fresh',
      brandId: 'brand_a',
      provider: 'SHOPIFY',
      displayName: 'Modal Freshness Store',
      configJson: {
        defaultPublishAsDraft: true,
        inlineJsonLd: true,
      },
    });
    listChannelConnectionsMock.mockResolvedValue({ items: [conn] });

    let resolveModalTest!: (v: ChannelConnectionTestResultDto) => void;
    testChannelConnectionMock.mockImplementationOnce(
      () =>
        new Promise<ChannelConnectionTestResultDto>((resolve) => {
          resolveModalTest = resolve;
        }),
    );

    let rejectSubmit!: (err: Error) => void;
    let resolveSubmit!: (v: ChannelConnectionDto) => void;
    updateChannelConnectionMock
      .mockImplementationOnce(
        () =>
          new Promise<ChannelConnectionDto>((_resolve, reject) => {
            rejectSubmit = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<ChannelConnectionDto>((resolve) => {
            resolveSubmit = resolve;
          }),
      );

    render(
      <BrandChannelConnections
        brandId="brand_a"
        activeMarket="GLOBAL"
        marketEnabled={true}
        readOnly={false}
        onEnableMarket={vi.fn()}
      />,
    );

    await screen.findByTestId('channel-connection-card-conn_modal_fresh');
    fireEvent.click(screen.getByTestId('channel-connection-edit-btn-conn_modal_fresh'));
    const modal = await screen.findByTestId('channel-connection-modal');

    // 1. Trigger runModalTest -> submit button becomes disabled while testing
    fireEvent.click(screen.getByTestId('channel-connection-modal-test-btn'));
    const submitBtn = screen.getByTestId('channel-connection-submit-btn') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);

    // 2. Fire same-brand freshness refresh while runModalTest is pending
    await act(async () => {
      invalidateFreshness('channel-connections');
    });
    await waitFor(() => {
      expect(listChannelConnectionsMock).toHaveBeenCalledTimes(2);
    });

    // 3. Resolve runModalTest -> submit button re-enables AND discovered target populates
    await act(async () => {
      resolveModalTest({
        ok: true,
        status: 'ACTIVE',
        message: 'MODAL_TEST_OK_AFTER_REFRESH',
        testedAt: '2026-11-23T06:45:00.000Z',
        targets: [{ id: 'gid://shopify/Blog/777', name: 'Fresh Blog', handle: 'fresh' }],
      });
    });

    await waitFor(() => {
      expect(
        (screen.getByTestId('channel-connection-submit-btn') as HTMLButtonElement).disabled,
      ).toBe(false);
      expect((within(modal).getByLabelText('Shopify Blog ID') as HTMLInputElement).value).toBe(
        'gid://shopify/Blog/777',
      );
    });
    expect(notifySuccessMock).toHaveBeenCalledWith('MODAL_TEST_OK_AFTER_REFRESH');

    // 4. Trigger handleModalSubmit, fire same-brand freshness refresh while pending, then reject -> submitting resets cleanly
    fireEvent.click(screen.getByTestId('channel-connection-submit-btn'));
    expect(
      screen.getByTestId('channel-connection-submit-btn').classList.contains('ant-btn-loading'),
    ).toBe(true);

    await act(async () => {
      invalidateFreshness('channel-connections');
    });
    await waitFor(() => {
      expect(listChannelConnectionsMock).toHaveBeenCalledTimes(3);
    });

    await act(async () => {
      rejectSubmit(new Error('临时网络波动'));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('channel-connection-submit-btn').classList.contains('ant-btn-loading'),
      ).toBe(false);
      expect(within(modal).getByText('临时网络波动')).toBeTruthy();
      expect(notifyErrorMock).toHaveBeenCalledWith('临时网络波动');
    });

    // 5. Retry handleModalSubmit, fire same-brand freshness refresh while pending, then resolve -> saves & closes modal
    fireEvent.click(screen.getByTestId('channel-connection-submit-btn'));
    await act(async () => {
      invalidateFreshness('channel-connections');
    });
    await waitFor(() => {
      expect(listChannelConnectionsMock).toHaveBeenCalledTimes(4);
    });

    await act(async () => {
      resolveSubmit({
        ...conn,
        displayName: 'Modal Freshness Store',
        configJson: {
          blogId: 'gid://shopify/Blog/777',
          blogHandle: 'fresh',
          defaultPublishAsDraft: true,
          inlineJsonLd: true,
        },
      });
    });

    await waitFor(() => {
      expect(notifySuccessMock).toHaveBeenCalledWith('已保存渠道连接「Modal Freshness Store」');
      expect(screen.queryByTestId('channel-connection-modal')).toBeNull();
    });
  });

  it('W-01: enforces synchronous single-flight mutexes on same-tick double-click for createChannelConnection and testChannelConnection', async () => {
    const existing = makeConn({ id: 'conn_card_mutex', displayName: 'Card Mutex Blog' });
    listChannelConnectionsMock.mockResolvedValue({ items: [existing] });

    let resolveCreate!: (val: ChannelConnectionDto) => void;
    createChannelConnectionMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );

    let resolveCardTest!: (val: ChannelConnectionTestResultDto) => void;
    testChannelConnectionMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCardTest = resolve;
        }),
    );

    render(
      <BrandChannelConnections
        brandId="brand_1"
        activeMarket="GLOBAL"
        marketEnabled={true}
        readOnly={false}
        onEnableMarket={vi.fn()}
      />,
    );

    // 1. Same-tick double-click on card test button -> strictly 1 testChannelConnection call
    const cardTestBtn = await screen.findByTestId('channel-connection-test-btn-conn_card_mutex');
    act(() => {
      cardTestBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      cardTestBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(testChannelConnectionMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCardTest({
        ok: true,
        status: 'ACTIVE',
        message: '连接测试通过',
        testedAt: '2026-11-23T06:20:00.000Z',
        targets: [],
      });
    });

    // 2. Same-tick double-click on submit + save-and-test -> strictly 1 createChannelConnection call
    fireEvent.click(screen.getByTestId('add-channel-connection-btn'));
    const modal = await screen.findByTestId('channel-connection-modal');
    fireEvent.click(within(modal).getByRole('tab', { name: /Custom App Token/ }));
    fireEvent.change(within(modal).getByLabelText('连接名称'), {
      target: { value: 'Single Flight Store' },
    });
    fireEvent.change(within(modal).getByLabelText('站点地址'), {
      target: { value: 'https://singleflight.myshopify.com' },
    });
    fireEvent.change(within(modal).getByLabelText('Shopify Access Token'), {
      target: { value: 'shpat_single_flight_token_123456' },
    });

    const submitBtn = screen.getByTestId('channel-connection-submit-btn');
    const saveAndTestBtn = screen.getByTestId('channel-connection-save-and-test-btn');
    act(() => {
      submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      saveAndTestBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(createChannelConnectionMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCreate(
        makeConn({
          id: 'conn_single_flight_created',
          displayName: 'Single Flight Store',
          siteBaseUrl: 'https://singleflight.myshopify.com',
        }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByTestId('channel-connection-modal')).toBeNull();
    });
  });

  it('supports Shopify OAuth 2.0 start with safe redirect validation and graceful 503 fallback to Custom App Token', async () => {
    const onOAuthRedirect = vi.fn();
    startShopifyOAuthMock
      .mockRejectedValueOnce(
        new GatewayApiError(
          503,
          50301,
          'Shopify OAuth 尚未配置（请先设置 SHOPIFY_OAUTH_CLIENT_ID 与 SHOPIFY_OAUTH_CLIENT_SECRET，或使用 Custom App Token 接入）',
        ),
      )
      .mockResolvedValueOnce({
        authorizeUrl: 'https://evil.example.com/phish',
        state: 'st_bad',
        shop: 'demo.myshopify.com',
        expiresAt: '2026-11-24T12:10:00.000Z',
      })
      .mockResolvedValueOnce({
        authorizeUrl: 'https://demo.myshopify.com/admin/oauth/authorize?client_id=cid&state=st_ok',
        state: 'st_ok',
        shop: 'demo.myshopify.com',
        expiresAt: '2026-11-24T12:10:00.000Z',
      });

    render(
      <BrandChannelConnections
        brandId="brand_1"
        activeMarket="GLOBAL"
        marketEnabled={true}
        readOnly={false}
        onEnableMarket={vi.fn()}
        supportedLocales={['en-US', 'de-DE']}
        onOAuthRedirect={onOAuthRedirect}
      />,
    );

    await waitFor(() => expect(listChannelConnectionsMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('add-channel-connection-btn'));
    const modal = await screen.findByTestId('channel-connection-modal');

    // Tab 1 (OAuth) is default
    expect(within(modal).getByTestId('shopify-oauth-tab-panel')).toBeTruthy();
    fireEvent.change(within(modal).getByTestId('shopify-oauth-shop-input'), {
      target: { value: 'demo.myshopify.com' },
    });

    // 1. 503 unconfigured -> shows fallback banner & switches to Custom tab on click
    fireEvent.click(within(modal).getByTestId('shopify-oauth-start-btn'));
    expect(await within(modal).findByTestId('shopify-oauth-503-fallback')).toBeTruthy();
    fireEvent.click(within(modal).getByTestId('shopify-switch-to-custom-btn'));
    expect(within(modal).getByLabelText('Shopify Access Token')).toBeTruthy();

    // Switch back to OAuth tab
    fireEvent.click(within(modal).getByRole('tab', { name: /Shopify OAuth 2\.0/ }));
    fireEvent.change(within(modal).getByTestId('shopify-oauth-shop-input'), {
      target: { value: 'demo.myshopify.com' },
    });

    // 2. Blocks unsafe redirect URL
    fireEvent.click(within(modal).getByTestId('shopify-oauth-start-btn'));
    expect(await within(modal).findByText(/拦截到不安全的 Shopify 授权跳转地址/)).toBeTruthy();
    expect(onOAuthRedirect).not.toHaveBeenCalled();

    // 3. Valid https://*.myshopify.com redirect succeeds
    fireEvent.click(within(modal).getByTestId('shopify-oauth-start-btn'));
    await waitFor(() => {
      expect(onOAuthRedirect).toHaveBeenCalledWith(
        'https://demo.myshopify.com/admin/oauth/authorize?client_id=cid&state=st_ok',
      );
    });
  });

  it('creates GHOST (validating hex key), DEVTO, HASHNODE (apiToken), and GITHUB_MDX connections with targetLocale', async () => {
    createChannelConnectionMock
      .mockResolvedValueOnce(
        makeConn({
          id: 'conn_ghost',
          provider: 'GHOST',
          displayName: 'Ghost DE Blog',
          siteBaseUrl: 'https://de.example.com',
          targetLocale: 'de-DE',
        }),
      )
      .mockResolvedValueOnce(
        makeConn({
          id: 'conn_devto',
          provider: 'DEVTO',
          displayName: 'Dev.to Official',
          siteBaseUrl: 'https://dev.to',
        }),
      )
      .mockResolvedValueOnce(
        makeConn({
          id: 'conn_hashnode',
          provider: 'HASHNODE',
          displayName: 'Hashnode Eng',
          siteBaseUrl: 'https://hashnode.com',
        }),
      )
      .mockResolvedValueOnce(
        makeConn({
          id: 'conn_gh',
          provider: 'GITHUB_MDX',
          displayName: 'Docs MDX Repo',
          siteBaseUrl: 'https://github.com/acme/docs',
          configJson: {
            repoOwner: 'acme',
            repoName: 'docs',
            branch: 'main',
            contentDir: 'content/blog',
            fileExtension: 'mdx',
          },
        }),
      );

    render(
      <BrandChannelConnections
        brandId="brand_1"
        activeMarket="GLOBAL"
        marketEnabled={true}
        readOnly={false}
        onEnableMarket={vi.fn()}
        supportedLocales={['en-US', 'de-DE']}
      />,
    );
    await waitFor(() => expect(listChannelConnectionsMock).toHaveBeenCalledTimes(1));

    // 1. GHOST with bad key -> validation error, then valid even-length hex key + targetLocale
    fireEvent.click(screen.getByTestId('add-channel-connection-btn'));
    let modal = await screen.findByTestId('channel-connection-modal');
    await selectAntdOption(within(modal).getByTestId('channel-provider-select'), 'Ghost 博客');
    fireEvent.change(within(modal).getByLabelText('连接名称'), {
      target: { value: 'Ghost DE Blog' },
    });
    fireEvent.change(within(modal).getByLabelText('站点地址'), {
      target: { value: 'https://de.example.com' },
    });
    fireEvent.change(within(modal).getByLabelText('Ghost Admin API Key'), {
      target: { value: 'bad-key-no-hex' },
    });
    fireEvent.click(screen.getByTestId('channel-connection-submit-btn'));
    expect(await within(modal).findByText(/格式为 id:hex_secret/)).toBeTruthy();

    fireEvent.change(within(modal).getByLabelText('Ghost Admin API Key'), {
      target: { value: '64a1b2c3:0123456789abcdef0123456789abcdef' },
    });
    await selectAntdOption(
      within(modal).getByTestId('channel-connection-locale-select'),
      '德语（德国） (de-DE) · Deutsch',
    );
    fireEvent.click(screen.getByTestId('channel-connection-submit-btn'));
    await waitFor(() => {
      expect(createChannelConnectionMock).toHaveBeenCalledWith(
        'brand_1',
        expect.objectContaining({
          provider: 'GHOST',
          targetLocale: 'de-DE',
          credentials: { adminApiKey: '64a1b2c3:0123456789abcdef0123456789abcdef' },
        }),
        expect.anything(),
      );
    });
    expect(await screen.findByTestId('channel-connection-locale-conn_ghost')).toBeTruthy();

    // 2. DEVTO
    fireEvent.click(screen.getByTestId('add-channel-connection-btn'));
    modal = await screen.findByTestId('channel-connection-modal');
    await selectAntdOption(within(modal).getByTestId('channel-provider-select'), 'Dev.to 技术社区');
    fireEvent.change(within(modal).getByLabelText('连接名称'), {
      target: { value: 'Dev.to Official' },
    });
    fireEvent.change(within(modal).getByLabelText('站点地址'), {
      target: { value: 'https://dev.to' },
    });
    fireEvent.change(within(modal).getByLabelText('Dev.to API Key'), {
      target: { value: 'devto_key_abc' },
    });
    fireEvent.click(screen.getByTestId('channel-connection-submit-btn'));
    await waitFor(() => {
      expect(createChannelConnectionMock).toHaveBeenCalledWith(
        'brand_1',
        expect.objectContaining({
          provider: 'DEVTO',
          credentials: { apiKey: 'devto_key_abc' },
        }),
        expect.anything(),
      );
    });

    // 3. HASHNODE (exact apiToken credential key)
    fireEvent.click(screen.getByTestId('add-channel-connection-btn'));
    modal = await screen.findByTestId('channel-connection-modal');
    await selectAntdOption(within(modal).getByTestId('channel-provider-select'), 'Hashnode 博客');
    fireEvent.change(within(modal).getByLabelText('连接名称'), {
      target: { value: 'Hashnode Eng' },
    });
    fireEvent.change(within(modal).getByLabelText('站点地址'), {
      target: { value: 'https://hashnode.com' },
    });
    fireEvent.change(within(modal).getByLabelText('Hashnode Personal Access Token'), {
      target: { value: 'hn_pat_12345' },
    });
    fireEvent.change(within(modal).getByLabelText('Hashnode Publication ID'), {
      target: { value: 'pub_xyz' },
    });
    fireEvent.click(screen.getByTestId('channel-connection-submit-btn'));
    await waitFor(() => {
      expect(createChannelConnectionMock).toHaveBeenCalledWith(
        'brand_1',
        expect.objectContaining({
          provider: 'HASHNODE',
          credentials: { apiToken: 'hn_pat_12345' },
          configJson: expect.objectContaining({ publicationId: 'pub_xyz' }),
        }),
        expect.anything(),
      );
    });

    // 4. GITHUB_MDX (repoOwner / repoName / branch / fileExtension)
    fireEvent.click(screen.getByTestId('add-channel-connection-btn'));
    modal = await screen.findByTestId('channel-connection-modal');
    await selectAntdOption(within(modal).getByTestId('channel-provider-select'), 'GitHub MDX 仓库');
    fireEvent.change(within(modal).getByLabelText('连接名称'), {
      target: { value: 'Docs MDX Repo' },
    });
    fireEvent.change(within(modal).getByLabelText('站点地址'), {
      target: { value: 'https://github.com/acme/docs' },
    });
    fireEvent.change(within(modal).getByLabelText('GitHub Personal Access Token'), {
      target: { value: 'ghp_test_token_123' },
    });
    fireEvent.change(within(modal).getByLabelText('GitHub 仓库所有者'), {
      target: { value: 'acme' },
    });
    fireEvent.change(within(modal).getByLabelText('GitHub 仓库名称'), {
      target: { value: 'docs' },
    });
    fireEvent.change(within(modal).getByLabelText('GitHub 目标分支'), {
      target: { value: 'main' },
    });
    fireEvent.click(screen.getByTestId('channel-connection-submit-btn'));
    await waitFor(() => {
      expect(createChannelConnectionMock).toHaveBeenCalledWith(
        'brand_1',
        expect.objectContaining({
          provider: 'GITHUB_MDX',
          credentials: { token: 'ghp_test_token_123' },
          configJson: expect.objectContaining({
            repoOwner: 'acme',
            repoName: 'docs',
            branch: 'main',
            fileExtension: 'mdx',
          }),
        }),
        expect.anything(),
      );
    });
    expect(await screen.findByText(/Repo: acme\/docs@main/)).toBeTruthy();
  });

  it('creates CN WECHAT_OFFICIAL connection with permanent draft-only & IP whitelist 40164 notices', async () => {
    listChannelConnectionsMock.mockResolvedValueOnce({
      items: [
        makeConn({
          id: 'conn_wx_existing',
          market: 'CN',
          provider: 'WECHAT_OFFICIAL',
          displayName: '官方服务号草稿箱',
          siteBaseUrl: 'https://mp.weixin.qq.com',
          status: 'INVALID',
          lastError: '微信公众号接口返回 IP 白名单拦截（错误码 40164）',
          configJson: { defaultPublishAsDraft: true, author: '品牌编辑部' },
        }),
      ],
    });
    createChannelConnectionMock.mockResolvedValueOnce(
      makeConn({
        id: 'conn_wx_new',
        market: 'CN',
        provider: 'WECHAT_OFFICIAL',
        displayName: '订阅号草稿箱',
        siteBaseUrl: 'https://mp.weixin.qq.com',
        configJson: { defaultPublishAsDraft: true, inlineJsonLd: false, needOpenComment: false },
      }),
    );

    render(
      <BrandChannelConnections
        brandId="brand_1"
        activeMarket="CN"
        marketEnabled={true}
        readOnly={false}
        onEnableMarket={vi.fn()}
      />,
    );

    // Card shows draft-only notice AND 40164 IP whitelist guidance
    const draftNotice = await screen.findByTestId('wechat-card-draft-notice-conn_wx_existing');
    expect(draftNotice.textContent).toContain('仅推送至公众号草稿箱，绝不自动群发');
    expect(draftNotice.textContent).toContain('40164');
    expect(screen.getByText(/处理指引：请登录微信公众平台/)).toBeTruthy();

    // Open modal & create WECHAT_OFFICIAL
    fireEvent.click(screen.getByTestId('add-channel-connection-btn'));
    const modal = await screen.findByTestId('channel-connection-modal');
    await selectAntdOption(
      within(modal).getByTestId('channel-provider-select'),
      '微信公众号草稿箱',
    );
    expect(within(modal).getByTestId('wechat-modal-draft-notice').textContent).toContain(
      '仅推送至公众号草稿箱，绝不自动群发',
    );
    fireEvent.change(within(modal).getByLabelText('连接名称'), {
      target: { value: '订阅号草稿箱' },
    });
    fireEvent.change(within(modal).getByLabelText('站点地址'), {
      target: { value: 'https://mp.weixin.qq.com' },
    });
    fireEvent.change(within(modal).getByLabelText('微信公众号 AppID'), {
      target: { value: 'wx1234567890abcdef' },
    });
    fireEvent.change(within(modal).getByLabelText('微信公众号 AppSecret'), {
      target: { value: 'secret_wx_12345' },
    });
    fireEvent.click(screen.getByTestId('channel-connection-submit-btn'));
    await waitFor(() => {
      expect(createChannelConnectionMock).toHaveBeenCalledWith(
        'brand_1',
        expect.objectContaining({
          market: 'CN',
          provider: 'WECHAT_OFFICIAL',
          credentials: { appId: 'wx1234567890abcdef', appSecret: 'secret_wx_12345' },
          configJson: expect.objectContaining({
            defaultPublishAsDraft: true,
            inlineJsonLd: false,
          }),
        }),
        expect.anything(),
      );
    });
  });

  it('BUG-3 regression: blocks Shopify OAuth authorizeUrl with non-standard port or non-authorize storefront redirect path', async () => {
    const onOAuthRedirect = vi.fn();
    startShopifyOAuthMock
      .mockResolvedValueOnce({
        authorizeUrl: 'https://demo.myshopify.com:8443/admin/oauth/authorize?client_id=cid',
        state: 'st_port',
        shop: 'demo.myshopify.com',
        expiresAt: '2026-11-24T12:10:00.000Z',
      })
      .mockResolvedValueOnce({
        authorizeUrl: 'https://demo.myshopify.com/evil-redirect?to=https://evil.com',
        state: 'st_path',
        shop: 'demo.myshopify.com',
        expiresAt: '2026-11-24T12:10:00.000Z',
      });

    render(
      <BrandChannelConnections
        brandId="brand_1"
        activeMarket="GLOBAL"
        marketEnabled={true}
        readOnly={false}
        onEnableMarket={vi.fn()}
        onOAuthRedirect={onOAuthRedirect}
      />,
    );
    await waitFor(() => expect(listChannelConnectionsMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('add-channel-connection-btn'));
    const modal = await screen.findByTestId('channel-connection-modal');
    fireEvent.change(within(modal).getByTestId('shopify-oauth-shop-input'), {
      target: { value: 'demo.myshopify.com' },
    });

    // 1. Non-standard port blocked
    fireEvent.click(within(modal).getByTestId('shopify-oauth-start-btn'));
    expect(await within(modal).findByText(/拦截到不安全的 Shopify 授权跳转地址/)).toBeTruthy();
    expect(onOAuthRedirect).not.toHaveBeenCalled();

    // 2. Arbitrary storefront path blocked
    fireEvent.click(within(modal).getByTestId('shopify-oauth-start-btn'));
    await waitFor(() => expect(startShopifyOAuthMock).toHaveBeenCalledTimes(2));
    expect(within(modal).getByText(/拦截到不安全的 Shopify 授权跳转地址/)).toBeTruthy();
    expect(onOAuthRedirect).not.toHaveBeenCalled();
  });

  it('BUG-4 regression: resets cross-provider hidden fields (tagsInput/primaryDomain) on provider switch and prevents Shopify OAuth edit downgrade via hidden accessToken', async () => {
    const oauthConn = makeConn({
      id: 'conn_shopify_oauth_1',
      provider: 'SHOPIFY',
      authType: 'OAUTH',
      displayName: 'OAuth Flagship Store',
      siteBaseUrl: 'https://flagship.myshopify.com',
      externalShopDomain: 'flagship.myshopify.com',
      configJson: { defaultPublishAsDraft: true, inlineJsonLd: true },
    });
    listChannelConnectionsMock.mockResolvedValue({ items: [oauthConn] });
    createChannelConnectionMock.mockResolvedValueOnce(
      makeConn({
        id: 'conn_hashnode_clean',
        provider: 'HASHNODE',
        displayName: 'Clean Hashnode',
        siteBaseUrl: 'https://hashnode.com',
      }),
    );
    updateChannelConnectionMock.mockResolvedValueOnce(oauthConn);

    render(
      <BrandChannelConnections
        brandId="brand_1"
        activeMarket="GLOBAL"
        marketEnabled={true}
        readOnly={false}
        onEnableMarket={vi.fn()}
      />,
    );
    await screen.findByTestId('channel-connection-card-conn_shopify_oauth_1');

    // Part A: Type tags under DEVTO -> switch to HASHNODE -> saved configJson MUST NOT leak tags
    fireEvent.click(screen.getByTestId('add-channel-connection-btn'));
    let modal = await screen.findByTestId('channel-connection-modal');
    await selectAntdOption(within(modal).getByTestId('channel-provider-select'), 'Dev.to 技术社区');
    fireEvent.change(within(modal).getByLabelText('Dev.to 默认标签'), {
      target: { value: 't1, t2, t3, t4, t5' },
    });

    await selectAntdOption(within(modal).getByTestId('channel-provider-select'), 'Hashnode 博客');
    fireEvent.change(within(modal).getByLabelText('连接名称'), {
      target: { value: 'Clean Hashnode' },
    });
    fireEvent.change(within(modal).getByLabelText('站点地址'), {
      target: { value: 'https://hashnode.com' },
    });
    fireEvent.change(within(modal).getByLabelText('Hashnode Personal Access Token'), {
      target: { value: 'hn_clean_token' },
    });
    fireEvent.click(screen.getByTestId('channel-connection-submit-btn'));
    await waitFor(() => expect(createChannelConnectionMock).toHaveBeenCalledTimes(1));
    const createdConfig = (
      createChannelConnectionMock.mock.calls[0]?.[1] as { configJson?: Record<string, unknown> }
    )?.configJson;
    expect(createdConfig).not.toHaveProperty('tags');

    // Part B: Edit OAuth Shopify connection -> switch to Custom tab, type token -> switch back to OAuth tab -> Save MUST NOT send credentials.accessToken
    fireEvent.click(screen.getByTestId('channel-connection-edit-btn-conn_shopify_oauth_1'));
    modal = await screen.findByTestId('channel-connection-modal');
    fireEvent.click(within(modal).getByRole('tab', { name: 'Custom App Token' }));
    fireEvent.change(within(modal).getByLabelText('Shopify Access Token'), {
      target: { value: 'shpat_TYPED_THEN_SWITCHED' },
    });
    fireEvent.click(within(modal).getByRole('tab', { name: /Shopify OAuth 2\.0/ }));
    fireEvent.click(screen.getByTestId('channel-connection-submit-btn'));
    await waitFor(() => expect(updateChannelConnectionMock).toHaveBeenCalledTimes(1));
    const patchPayload = updateChannelConnectionMock.mock.calls[0]?.[2] as {
      credentials?: Record<string, string>;
    };
    expect(patchPayload.credentials).toBeUndefined();
  });
});
