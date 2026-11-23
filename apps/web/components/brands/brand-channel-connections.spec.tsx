// @vitest-environment jsdom

import type { ChannelConnectionDto, ChannelConnectionTestResultDto } from '@geomix/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayApiError } from '../../lib/envelope';
import * as studioLib from '../../lib/studio';
import { BrandChannelConnections } from './brand-channel-connections';

const listChannelConnectionsMock = vi.fn();
const createChannelConnectionMock = vi.fn();
const updateChannelConnectionMock = vi.fn();
const deleteChannelConnectionMock = vi.fn();
const testChannelConnectionMock = vi.fn();

vi.mock('../../lib/distribution', () => ({
  listChannelConnections: (...args: unknown[]) => listChannelConnectionsMock(...args),
  createChannelConnection: (...args: unknown[]) => createChannelConnectionMock(...args),
  updateChannelConnection: (...args: unknown[]) => updateChannelConnectionMock(...args),
  deleteChannelConnection: (...args: unknown[]) => deleteChannelConnectionMock(...args),
  testChannelConnection: (...args: unknown[]) => testChannelConnectionMock(...args),
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
  listChannelConnectionsMock.mockResolvedValue({ items: [] });
});

afterEach(async () => {
  cleanup();
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
    updateChannelConnectionMock.mockResolvedValueOnce(wfConn);

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
});
