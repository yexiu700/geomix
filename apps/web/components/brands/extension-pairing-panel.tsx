'use client';

import {
  EXTENSION_DEFAULT_TTL_DAYS,
  EXTENSION_MAX_TTL_DAYS,
  formatShanghaiDateTime,
  type ExtensionTokenDto,
} from '@geomix/shared';
import { Alert, Button, Input, Modal, Tag } from 'antd';
import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { GatewayApiError } from '../../lib/envelope';
import {
  createExtensionToken,
  listExtensionTokens,
  revokeExtensionToken,
} from '../../lib/extension';
import { copyTextToClipboard } from '../../lib/studio';
import { invalidateFreshness, useTabFreshness } from '../../lib/tab-freshness';
import { useUxFeedback } from '../crud/ux-feedback';
import { SignalEmpty, SignalError, SignalPill, SignalSkeleton } from '../geo/primitives';

export type ExtensionPairingPanelProps = {
  readOnly: boolean;
  /** 'brands' renders Section 5 heading + #brand-section-extension anchor; 'account' renders standalone tab layout */
  variant?: 'brands' | 'account';
  /** Controls useTabFreshness active flag & initial load gating (default true) */
  active?: boolean;
};

type IssuedSecretState = {
  label: string;
  tokenPrefix: string;
  expiresAt: string;
  plainToken: string;
};

function formatExtensionError(err: unknown, fallback: string): string {
  if (err instanceof GatewayApiError) {
    if (err.status === 429) {
      return err.message || '请求过于频繁，请稍后再试';
    }
    if (err.status === 403) {
      return err.message || '账号当前为只读状态，无法变更扩展配对令牌';
    }
    return err.message || fallback;
  }
  if (err instanceof Error && err.message.trim()) {
    return err.message;
  }
  return fallback;
}

function resolveTokenStatus(token: ExtensionTokenDto): {
  tone: 'cited' | 'warning' | 'neutral';
  label: string;
} {
  if (token.revokedAt) {
    return { tone: 'neutral', label: '已吊销' };
  }
  const expiresMs = Date.parse(token.expiresAt);
  if (Number.isFinite(expiresMs) && expiresMs <= Date.now()) {
    return { tone: 'warning', label: '已过期' };
  }
  return { tone: 'cited', label: '生效中' };
}

function formatScopeLabel(scope: string): string {
  if (scope === 'extension:distribution') {
    return '分发队列桥接 (extension:distribution)';
  }
  return scope;
}

export function ExtensionPairingPanel({
  readOnly,
  variant = 'brands',
  active = true,
}: ExtensionPairingPanelProps): JSX.Element {
  const feedback = useUxFeedback();

  const [tokens, setTokens] = useState<ExtensionTokenDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [label, setLabel] = useState('');
  const [ttlText, setTtlText] = useState<string>(String(EXTENSION_DEFAULT_TTL_DAYS));
  const [formError, setFormError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  // One-time plaintext secret disclosure state — strictly wiped on close / inactive / unmount
  const [issuedSecret, setIssuedSecret] = useState<IssuedSecretState | null>(null);
  const [copiedSecret, setCopiedSecret] = useState(false);

  const activeRef = useRef(active);
  activeRef.current = active;
  const mountedRef = useRef(true);
  const loadSeqRef = useRef(0);
  const loadCtrlRef = useRef<AbortController | null>(null);
  const createCtrlRef = useRef<AbortController | null>(null);
  const revokeCtrlsRef = useRef<Set<AbortController>>(new Set());
  const revokingRef = useRef<Set<string>>(new Set());
  const creatingRef = useRef(false);
  const skipNextSelfRefreshRef = useRef(false);
  const loadedOnceRef = useRef(false);

  const closeSecretModal = useCallback(() => {
    setIssuedSecret(null);
    setCopiedSecret(false);
  }, []);

  const broadcastTokensChanged = useCallback(() => {
    skipNextSelfRefreshRef.current = true;
    try {
      invalidateFreshness('extension-tokens');
    } finally {
      skipNextSelfRefreshRef.current = false;
    }
  }, []);

  const loadTokens = useCallback(async (options?: { silent?: boolean }) => {
    loadCtrlRef.current?.abort();
    const ctrl = new AbortController();
    loadCtrlRef.current = ctrl;
    const seq = ++loadSeqRef.current;

    if (!options?.silent) {
      setLoading(true);
      setError(null);
    }

    try {
      const res = await listExtensionTokens({
        storage: window.sessionStorage,
        signal: ctrl.signal,
      });
      if (ctrl.signal.aborted || seq !== loadSeqRef.current) return;
      setTokens(res.items);
      setError(null);
      loadedOnceRef.current = true;
    } catch (err) {
      if (ctrl.signal.aborted || seq !== loadSeqRef.current) return;
      setError(formatExtensionError(err, '无法加载 Chrome 扩展配对令牌'));
    } finally {
      if (!ctrl.signal.aborted && seq === loadSeqRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!active) {
      // Wipe any one-time secret and abort any in-flight token creation when tab/section becomes inactive
      closeSecretModal();
      createCtrlRef.current?.abort();
      createCtrlRef.current = null;
      creatingRef.current = false;
      setCreating(false);
      return;
    }
    if (!loadedOnceRef.current) {
      void loadTokens();
    }
  }, [active, closeSecretModal, loadTokens]);

  useEffect(() => {
    mountedRef.current = true;
    const revokeCtrls = revokeCtrlsRef.current;
    const revoking = revokingRef.current;
    return () => {
      mountedRef.current = false;
      loadSeqRef.current += 1;
      creatingRef.current = false;
      loadCtrlRef.current?.abort();
      createCtrlRef.current?.abort();
      for (const ctrl of revokeCtrls) {
        ctrl.abort();
      }
      revokeCtrls.clear();
      revoking.clear();
      setIssuedSecret(null);
    };
  }, []);

  useTabFreshness({
    active,
    domains: ['extension-tokens'],
    refreshOnActivate: true,
    onRefresh: () => {
      if (skipNextSelfRefreshRef.current) return;
      void loadTokens({ silent: true });
    },
  });

  const handleCreateToken = async () => {
    if (readOnly || creatingRef.current || !activeRef.current) return;
    setFormError(null);
    const trimmedLabel = label.trim();
    if (!trimmedLabel) {
      setFormError('请填写设备或浏览器备注名称');
      return;
    }
    if (trimmedLabel.length > 64) {
      setFormError('备注名称最多 64 个字符');
      return;
    }
    const trimmedTtl = ttlText.trim();
    if (!/^\d+$/.test(trimmedTtl)) {
      setFormError(`有效期需为 1 至 ${EXTENSION_MAX_TTL_DAYS} 之间的整数天`);
      return;
    }
    const normalizedTtl = Number(trimmedTtl);
    if (
      !Number.isSafeInteger(normalizedTtl) ||
      normalizedTtl < 1 ||
      normalizedTtl > EXTENSION_MAX_TTL_DAYS
    ) {
      setFormError(`有效期需在 1 至 ${EXTENSION_MAX_TTL_DAYS} 天之间`);
      return;
    }

    creatingRef.current = true;
    createCtrlRef.current?.abort();
    const ctrl = new AbortController();
    createCtrlRef.current = ctrl;
    setCreating(true);

    try {
      const res = await createExtensionToken(
        { label: trimmedLabel, ttlDays: normalizedTtl },
        { storage: window.sessionStorage, signal: ctrl.signal },
      );
      if (ctrl.signal.aborted || !activeRef.current || !mountedRef.current) return;
      // Store only masked DTO in list state; plainToken lives exclusively in one-time modal state
      setTokens((prev) => [res.token, ...prev.filter((item) => item.id !== res.token.id)]);
      setLabel('');
      setTtlText(String(EXTENSION_DEFAULT_TTL_DAYS));
      setCopiedSecret(false);
      setIssuedSecret({
        label: res.token.label,
        tokenPrefix: res.token.tokenPrefix,
        expiresAt: res.token.expiresAt,
        plainToken: res.plainToken,
      });
      broadcastTokensChanged();
      feedback.notifySuccess('已生成扩展配对令牌，请立即复制保存');
    } catch (err) {
      if (ctrl.signal.aborted || !activeRef.current || !mountedRef.current) return;
      const msg = formatExtensionError(err, '生成扩展配对令牌失败');
      setFormError(msg);
      feedback.notifyError(msg);
    } finally {
      if (createCtrlRef.current === ctrl) {
        createCtrlRef.current = null;
      }
      creatingRef.current = false;
      if (mountedRef.current && !ctrl.signal.aborted) {
        setCreating(false);
      }
    }
  };

  const handleRevokeToken = (token: ExtensionTokenDto) => {
    if (readOnly || token.revokedAt || revokingRef.current.has(token.id)) return;
    feedback.confirm({
      title: `确认吊销配对令牌「${token.label}」？`,
      content:
        '吊销后该浏览器上的 Chrome 扩展将立即失去同步权限（返回 401），需重新生成新令牌配对。',
      okText: '确认吊销',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        if (revokingRef.current.has(token.id)) return;
        revokingRef.current.add(token.id);
        const ctrl = new AbortController();
        revokeCtrlsRef.current.add(ctrl);
        setRevokingId(token.id);
        try {
          const res = await revokeExtensionToken(token.id, {
            storage: window.sessionStorage,
            signal: ctrl.signal,
          });
          if (ctrl.signal.aborted) return;
          setTokens((prev) =>
            prev.map((item) =>
              item.id === token.id ? { ...item, revokedAt: res.revokedAt } : item,
            ),
          );
          broadcastTokensChanged();
          feedback.notifySuccess(`已吊销配对令牌「${token.label}」`);
        } catch (err) {
          if (ctrl.signal.aborted) return;
          feedback.notifyError(formatExtensionError(err, '吊销扩展配对令牌失败'));
        } finally {
          revokeCtrlsRef.current.delete(ctrl);
          revokingRef.current.delete(token.id);
          if (!ctrl.signal.aborted) {
            setRevokingId((prev) => (prev === token.id ? null : prev));
          }
        }
      },
    });
  };

  const handleCopyPlainToken = () => {
    if (!issuedSecret?.plainToken) return;
    void copyTextToClipboard(issuedSecret.plainToken).then((ok) => {
      if (ok) {
        setCopiedSecret(true);
        feedback.notifySuccess('配对令牌已复制到剪贴板');
      } else {
        feedback.notifyWarning('自动复制失败，请手动选中令牌明文复制');
      }
    });
  };

  const sectionId = variant === 'brands' ? 'brand-section-extension' : 'account-section-extension';
  const headingTitle =
    variant === 'brands' ? '5. 国内 L2 Chrome 扩展配对' : '国内 L2 Chrome 扩展配对令牌';

  return (
    <section
      id={sectionId}
      className="gm-brand-section"
      aria-label="国内 L2 Chrome 扩展配对"
      data-testid="extension-pairing-panel"
      style={{ minWidth: 0, maxWidth: '100%', boxSizing: 'border-box' }}
    >
      <div
        className="gm-brand-section-head"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 12,
        }}
      >
        <div style={{ minWidth: 0, flex: '1 1 320px' }}>
          <div className="gm-brand-section-title-row">
            <h4 className="gm-brand-section-title">{headingTitle}</h4>
            <Tag color="cyan" style={{ margin: 0, whiteSpace: 'nowrap', flexShrink: 0 }}>
              CN · Bridge v1
            </Tag>
          </div>
          <p className="gm-brand-section-desc">
            用于配对 GeoMix Chrome
            扩展，将写作台排队的知乎、今日头条、什么值得买变体一键填充到平台草稿箱，并回传已发公网链接开启自动复测；扩展绝不读取平台
            Cookie，绝不自动点击最终发布。
          </p>
        </div>

        <Button
          size="small"
          data-testid="extension-token-refresh-btn"
          loading={loading}
          style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
          onClick={() => void loadTokens()}
        >
          刷新列表
        </Button>
      </div>

      {/* Create Extension Pairing Token Form */}
      <div
        className="gm-brand-subcard"
        style={{
          marginBottom: 14,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          minWidth: 0,
          maxWidth: '100%',
          boxSizing: 'border-box',
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--gm-fg-1)' }}>
          生成新配对令牌（明文仅展示一次）
        </div>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'flex-end',
            gap: 10,
            minWidth: 0,
          }}
        >
          <div style={{ flex: '1 1 240px', minWidth: 0 }}>
            <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginBottom: 4 }}>
              设备或浏览器名称
            </div>
            <Input
              aria-label="设备或浏览器名称"
              data-testid="extension-token-label-input"
              maxLength={64}
              disabled={readOnly || creating}
              placeholder="例如：MacBook 公司 Chrome"
              value={label}
              onChange={(e) => {
                setLabel(e.target.value);
                if (formError) setFormError(null);
              }}
              onPressEnter={() => void handleCreateToken()}
            />
          </div>

          <div style={{ flex: '0 1 150px', minWidth: 130 }}>
            <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginBottom: 4 }}>
              有效期（1–{EXTENSION_MAX_TTL_DAYS} 天）
            </div>
            <Input
              aria-label="令牌有效期（天）"
              data-testid="extension-token-ttl-input"
              inputMode="numeric"
              style={{ width: '100%' }}
              disabled={readOnly || creating}
              value={ttlText}
              onChange={(e) => {
                setTtlText(e.target.value);
                if (formError) setFormError(null);
              }}
              onPressEnter={() => void handleCreateToken()}
            />
          </div>

          <Button
            type="primary"
            data-testid="extension-token-create-btn"
            loading={creating}
            disabled={readOnly}
            style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
            onClick={() => void handleCreateToken()}
          >
            生成扩展配对令牌
          </Button>
        </div>

        {formError ? (
          <Alert
            type="error"
            showIcon
            message={formError}
            style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}
          />
        ) : null}

        {readOnly ? (
          <div style={{ fontSize: 12, color: 'var(--gm-fg-3)' }}>
            当前账号处于只读状态，仅支持查看已有配对令牌，暂不可生成或吊销令牌。
          </div>
        ) : null}
      </div>

      {/* Masked Token List */}
      {loading && tokens.length === 0 ? (
        <SignalSkeleton variant="block" height={120} />
      ) : error ? (
        <SignalError message={error} onRetry={() => void loadTokens()} />
      ) : tokens.length === 0 ? (
        <SignalEmpty
          title="尚未配对任何 Chrome 扩展设备"
          description="点击上方「生成扩展配对令牌」获取一次性 gmext_ 令牌，粘贴至 GeoMix Chrome 扩展即可同步国内待发草稿队列。"
        />
      ) : (
        <div
          data-testid="extension-token-list"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))',
            gap: 12,
            minWidth: 0,
          }}
        >
          {tokens.map((token) => {
            const statusMeta = resolveTokenStatus(token);
            const isRevoked = Boolean(token.revokedAt);
            return (
              <div
                key={token.id}
                className="gm-brand-subcard"
                data-testid={`extension-token-card-${token.id}`}
                style={{
                  minWidth: 0,
                  maxWidth: '100%',
                  boxSizing: 'border-box',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    gap: 8,
                  }}
                >
                  <div style={{ minWidth: 0, flex: '1 1 180px' }}>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: 'var(--gm-fg-1)',
                        overflowWrap: 'anywhere',
                      }}
                    >
                      {token.label}
                    </div>
                    <div
                      className="gm-mono"
                      data-testid={`extension-token-prefix-${token.id}`}
                      style={{
                        fontSize: 12,
                        color: 'var(--gm-fg-2)',
                        marginTop: 3,
                        overflowWrap: 'anywhere',
                      }}
                    >
                      {token.tokenPrefix}••••••••
                    </div>
                  </div>
                  <SignalPill tone={statusMeta.tone}>{statusMeta.label}</SignalPill>
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {token.scopes.map((scope) => (
                    <Tag
                      key={scope}
                      color="blue"
                      style={{
                        margin: 0,
                        maxWidth: '100%',
                        whiteSpace: 'normal',
                        overflowWrap: 'anywhere',
                      }}
                    >
                      {formatScopeLabel(scope)}
                    </Tag>
                  ))}
                </div>

                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 3,
                    fontSize: 12,
                    color: 'var(--gm-fg-3)',
                  }}
                >
                  <div>创建时间：{formatShanghaiDateTime(token.createdAt)}</div>
                  <div>
                    最近使用：
                    {token.lastUsedAt ? formatShanghaiDateTime(token.lastUsedAt) : '尚未使用'}
                  </div>
                  <div>有效期至：{formatShanghaiDateTime(token.expiresAt)}</div>
                  {token.revokedAt ? (
                    <div style={{ color: 'var(--gm-warning)' }}>
                      吊销时间：{formatShanghaiDateTime(token.revokedAt)}
                    </div>
                  ) : null}
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'auto' }}>
                  <Button
                    size="small"
                    danger
                    data-testid={`extension-token-revoke-${token.id}`}
                    loading={revokingId === token.id}
                    disabled={readOnly || isRevoked}
                    style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                    onClick={() => handleRevokeToken(token)}
                  >
                    {isRevoked ? '已吊销' : '吊销令牌'}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* One-Time Plaintext Token Disclosure Modal */}
      <Modal
        open={Boolean(issuedSecret)}
        title="扩展配对令牌已生成（仅展示一次）"
        width="min(560px, calc(100vw - 32px))"
        destroyOnHidden
        maskClosable={false}
        onCancel={closeSecretModal}
        afterClose={closeSecretModal}
        styles={{
          body: { overflowX: 'hidden', maxHeight: '72vh', overflowY: 'auto' },
        }}
        footer={
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 }}>
            <Button
              data-testid="extension-token-copy-btn"
              style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
              onClick={handleCopyPlainToken}
            >
              {copiedSecret ? '已复制令牌' : '复制令牌'}
            </Button>
            <Button
              type="primary"
              data-testid="extension-token-modal-close-btn"
              style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
              onClick={closeSecretModal}
            >
              我已复制并关闭
            </Button>
          </div>
        }
      >
        {issuedSecret ? (
          <div
            data-testid="extension-token-secret-modal"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              minWidth: 0,
              maxWidth: '100%',
            }}
          >
            <Alert
              type="warning"
              showIcon
              message="此配对令牌明文仅展示这一次"
              description="关闭弹窗后系统将立即清除明文且无法再次查看；如遗失请吊销旧令牌并重新生成。"
            />

            <div style={{ fontSize: 12, color: 'var(--gm-fg-2)' }}>
              设备备注：<strong style={{ color: 'var(--gm-fg-1)' }}>{issuedSecret.label}</strong>
              {' · '}
              有效期至：{formatShanghaiDateTime(issuedSecret.expiresAt)}
            </div>

            <div
              style={{
                padding: '10px 12px',
                borderRadius: 'var(--gm-radius-sm)',
                border: '1px solid var(--gm-phosphor-a40)',
                background: 'var(--gm-bg-base)',
              }}
            >
              <code
                data-testid="extension-token-plain-secret"
                className="gm-num"
                style={{
                  display: 'block',
                  fontFamily: 'var(--gm-font-mono)',
                  fontSize: 13,
                  color: 'var(--gm-fg-1)',
                  wordBreak: 'break-all',
                  overflowWrap: 'anywhere',
                  userSelect: 'all',
                }}
              >
                {issuedSecret.plainToken}
              </code>
            </div>

            <div
              style={{
                fontSize: 12,
                color: 'var(--gm-fg-3)',
                lineHeight: 1.6,
              }}
            >
              <div>配对步骤：</div>
              <div>1. 在 Chrome 中安装并打开 GeoMix 扩展设置页；</div>
              <div>2. 粘贴上方 `gmext_` 配对令牌并点击验证连接；</div>
              <div>
                3. 令牌仅限待发草稿队列同步与公网链接回传，绝不读取平台 Cookie、绝不自动点击发布。
              </div>
            </div>
          </div>
        ) : null}
      </Modal>
    </section>
  );
}
