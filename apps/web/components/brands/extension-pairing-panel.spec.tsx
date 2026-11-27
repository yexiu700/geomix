// @vitest-environment jsdom

import type { ExtensionTokenDto } from '@geomix/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayApiError } from '../../lib/envelope';
import * as studioLib from '../../lib/studio';
import { resetFreshnessForTests, subscribeFreshness } from '../../lib/tab-freshness';
import { ExtensionPairingPanel } from './extension-pairing-panel';

const listExtensionTokensMock = vi.fn();
const createExtensionTokenMock = vi.fn();
const revokeExtensionTokenMock = vi.fn();

vi.mock('../../lib/extension', () => ({
  listExtensionTokens: (...args: unknown[]) => listExtensionTokensMock(...args),
  createExtensionToken: (...args: unknown[]) => createExtensionTokenMock(...args),
  revokeExtensionToken: (...args: unknown[]) => revokeExtensionTokenMock(...args),
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

function makeToken(overrides: Partial<ExtensionTokenDto> = {}): ExtensionTokenDto {
  return {
    id: 'ext_1',
    label: '运营 Chrome',
    tokenPrefix: 'gmext_Ab12Cd',
    scopes: ['extension:distribution'],
    lastUsedAt: '2026-11-23T02:30:00.000Z',
    expiresAt: '2027-02-21T02:30:00.000Z',
    revokedAt: null,
    createdAt: '2026-11-22T02:30:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetFreshnessForTests();
  listExtensionTokensMock.mockResolvedValue({ items: [] });
});

afterEach(async () => {
  cleanup();
  resetFreshnessForTests();
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  vi.restoreAllMocks();
});

describe('ExtensionPairingPanel (CN Chrome Extension Pairing)', () => {
  it('renders masked token list with Shanghai timestamps and zero plaintext leakage or checkboxes', async () => {
    listExtensionTokensMock.mockResolvedValueOnce({
      items: [
        makeToken({ id: 'ext_active', label: '主办公 Mac Chrome', tokenPrefix: 'gmext_112233' }),
        makeToken({
          id: 'ext_revoked',
          label: '旧笔记本 Chrome',
          tokenPrefix: 'gmext_998877',
          lastUsedAt: null,
          revokedAt: '2026-11-23T10:00:00.000Z',
        }),
      ],
    });

    render(<ExtensionPairingPanel readOnly={false} variant="brands" />);

    expect(await screen.findByTestId('extension-token-card-ext_active')).toBeTruthy();
    expect(screen.getByTestId('extension-token-prefix-ext_active').textContent).toBe(
      'gmext_112233••••••••',
    );
    expect(screen.getByText('生效中')).toBeTruthy();
    expect(screen.getAllByText('已吊销').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/尚未使用/)).toBeTruthy();
    expect(screen.getAllByText(/分发队列桥接/).length).toBeGreaterThanOrEqual(1);
    expect(document.body.textContent).not.toContain('extension:distribution');
    // Single-checkbox invariant on /brands: panel must NEVER render a checkbox in default view
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('issues token, shows one-time gmext_ secret modal with copy, and COMPLETELY wipes plaintext on close', async () => {
    const plainSecret = 'gmext_ONE_TIME_SECRET_999999999999999999999999';
    const createdToken = makeToken({
      id: 'ext_new_1',
      label: '市场部 Chrome',
      tokenPrefix: 'gmext_ONE_TI',
    });
    createExtensionTokenMock.mockResolvedValueOnce({
      token: createdToken,
      plainToken: plainSecret,
    });
    const copySpy = vi.spyOn(studioLib, 'copyTextToClipboard').mockResolvedValue(true);
    const freshnessListener = vi.fn();
    const unsub = subscribeFreshness(freshnessListener);

    render(<ExtensionPairingPanel readOnly={false} variant="account" />);
    await waitFor(() => expect(listExtensionTokensMock).toHaveBeenCalledTimes(1));

    // Rejects blank label client-side
    fireEvent.click(screen.getByTestId('extension-token-create-btn'));
    expect(await screen.findByText('请填写设备或浏览器备注名称')).toBeTruthy();
    expect(createExtensionTokenMock).not.toHaveBeenCalled();

    // Fill label and create
    fireEvent.change(screen.getByTestId('extension-token-label-input'), {
      target: { value: '市场部 Chrome' },
    });
    fireEvent.click(screen.getByTestId('extension-token-create-btn'));

    const secretModal = await screen.findByTestId('extension-token-secret-modal');
    expect(within(secretModal).getByTestId('extension-token-plain-secret').textContent).toBe(
      plainSecret,
    );
    expect(within(secretModal).getByText(/此配对令牌明文仅展示这一次/)).toBeTruthy();
    expect(freshnessListener).toHaveBeenCalledWith(new Set(['extension-tokens']));

    // Copy plaintext token
    fireEvent.click(screen.getByTestId('extension-token-copy-btn'));
    await waitFor(() => {
      expect(copySpy).toHaveBeenCalledWith(plainSecret);
      expect(notifySuccessMock).toHaveBeenCalledWith('配对令牌已复制到剪贴板');
    });

    // Close modal -> plaintext MUST be completely wiped from DOM and never re-shown
    fireEvent.click(screen.getByTestId('extension-token-modal-close-btn'));
    await waitFor(() => {
      expect(screen.queryByTestId('extension-token-plain-secret')).toBeNull();
    });
    expect(document.body.textContent).not.toContain(plainSecret);
    // List shows only masked prefix
    expect(screen.getByTestId('extension-token-prefix-ext_new_1').textContent).toBe(
      'gmext_ONE_TI••••••••',
    );
    unsub();
  });

  it('revokes token via useUxFeedback().confirm and updates row status + freshness', async () => {
    listExtensionTokensMock.mockResolvedValueOnce({
      items: [makeToken({ id: 'ext_rev_target', label: '测试 Chrome' })],
    });
    revokeExtensionTokenMock.mockResolvedValueOnce({
      id: 'ext_rev_target',
      revoked: true,
      revokedAt: '2026-11-24T05:00:00.000Z',
    });
    const freshnessListener = vi.fn();
    const unsub = subscribeFreshness(freshnessListener);

    render(<ExtensionPairingPanel readOnly={false} variant="brands" />);
    const revokeBtn = await screen.findByTestId('extension-token-revoke-ext_rev_target');
    fireEvent.click(revokeBtn);

    expect(confirmMock).toHaveBeenCalledTimes(1);
    const confirmArgs = confirmMock.mock.calls[0]?.[0] as { onOk: () => Promise<void> };
    await act(async () => {
      await confirmArgs.onOk();
    });

    expect(revokeExtensionTokenMock).toHaveBeenCalledWith(
      'ext_rev_target',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(freshnessListener).toHaveBeenCalledWith(new Set(['extension-tokens']));
    await waitFor(() => {
      expect(
        (screen.getByTestId('extension-token-revoke-ext_rev_target') as HTMLButtonElement).disabled,
      ).toBe(true);
    });
    unsub();
  });

  it('allows viewing tokens in readOnly mode while disabling create and revoke actions, and handles 429/load errors', async () => {
    listExtensionTokensMock.mockRejectedValueOnce(new GatewayApiError(500, -1, '服务繁忙'));

    const { rerender } = render(<ExtensionPairingPanel readOnly={true} variant="brands" />);
    expect(await screen.findByText('服务繁忙')).toBeTruthy();

    // Retry succeeds in readOnly mode
    listExtensionTokensMock.mockResolvedValueOnce({
      items: [makeToken({ id: 'ext_ro_1', label: '只读设备' })],
    });
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));

    expect(await screen.findByTestId('extension-token-card-ext_ro_1')).toBeTruthy();
    expect((screen.getByTestId('extension-token-create-btn') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByTestId('extension-token-revoke-ext_ro_1') as HTMLButtonElement).disabled,
    ).toBe(true);

    // Non-readOnly 429 error feedback
    rerender(<ExtensionPairingPanel readOnly={false} variant="brands" />);
    createExtensionTokenMock.mockRejectedValueOnce(
      new GatewayApiError(429, 42901, '操作过于频繁，请 60 秒后再试'),
    );
    fireEvent.change(screen.getByTestId('extension-token-label-input'), {
      target: { value: '限流测试设备' },
    });
    fireEvent.click(screen.getByTestId('extension-token-create-btn'));
    expect(await screen.findByText('操作过于频繁，请 60 秒后再试')).toBeTruthy();
  });

  it('BUG-1 regression: aborts in-flight createExtensionToken and never leaks plaintext gmext_ modal when active flips false', async () => {
    const leakedSecret = 'gmext_INFLIGHT_LEAK_SECRET_0123456789abcdef';
    let capturedSignal: AbortSignal | undefined;
    let resolveCreate!: (value: { token: ExtensionTokenDto; plainToken: string }) => void;

    createExtensionTokenMock.mockImplementationOnce(
      (_input: unknown, opts?: { signal?: AbortSignal }) => {
        capturedSignal = opts?.signal;
        return new Promise((resolve) => {
          resolveCreate = resolve;
        });
      },
    );

    const { rerender } = render(
      <ExtensionPairingPanel readOnly={false} variant="account" active={true} />,
    );
    await waitFor(() => expect(listExtensionTokensMock).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId('extension-token-label-input'), {
      target: { value: '切页竞态测试 Chrome' },
    });
    fireEvent.click(screen.getByTestId('extension-token-create-btn'));
    await waitFor(() => expect(createExtensionTokenMock).toHaveBeenCalledTimes(1));
    expect(capturedSignal?.aborted).toBe(false);

    // Deactivate panel while POST is still in flight
    rerender(<ExtensionPairingPanel readOnly={false} variant="account" active={false} />);
    expect(capturedSignal?.aborted).toBe(true);

    // Even if transport resolves despite abort, plaintext modal MUST NEVER appear
    await act(async () => {
      resolveCreate({
        token: makeToken({ id: 'ext_race_1', label: '切页竞态测试 Chrome' }),
        plainToken: leakedSecret,
      });
      await Promise.resolve();
    });

    expect(screen.queryByTestId('extension-token-secret-modal')).toBeNull();
    expect(screen.queryByTestId('extension-token-plain-secret')).toBeNull();
    expect(document.body.textContent).not.toContain(leakedSecret);
  });

  it('BUG-2 regression: strictly rejects invalid ttlDays inputs (0, 366, -1, 12.5, empty, abc) without calling createExtensionToken', async () => {
    render(<ExtensionPairingPanel readOnly={false} variant="brands" active={true} />);
    await waitFor(() => expect(listExtensionTokensMock).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId('extension-token-label-input'), {
      target: { value: '有效期校验测试 Chrome' },
    });
    const ttlInput = screen.getByTestId('extension-token-ttl-input');
    const createBtn = screen.getByTestId('extension-token-create-btn');

    for (const invalidValue of ['0', '366', '-1', '12.5', '', 'abc']) {
      fireEvent.change(ttlInput, { target: { value: invalidValue } });
      fireEvent.click(createBtn);
      expect(await screen.findByText(/有效期需/)).toBeTruthy();
      expect(createExtensionTokenMock).not.toHaveBeenCalled();
    }

    // Valid integer ttlDays succeeds and passes exact parsed integer
    createExtensionTokenMock.mockResolvedValueOnce({
      token: makeToken({ id: 'ext_ttl_ok', label: '有效期校验测试 Chrome' }),
      plainToken: 'gmext_VALID_TTL_TOKEN_1234567890',
    });
    fireEvent.change(ttlInput, { target: { value: '30' } });
    fireEvent.click(createBtn);
    await waitFor(() => {
      expect(createExtensionTokenMock).toHaveBeenCalledWith(
        { label: '有效期校验测试 Chrome', ttlDays: 30 },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });
});
