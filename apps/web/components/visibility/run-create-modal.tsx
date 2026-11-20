'use client';

import {
  DOMESTIC_VISIBILITY_ENGINE_KEYS,
  VISIBILITY_ENGINES,
  VISIBILITY_RUN_NAME_MAX,
  filterKeywordsForVisibilityProfile,
  quoteVisibilityRunPoints,
  resolveDefaultKeywordIdForProfile,
  type KeywordRecord,
  type QuestionRecord,
  type VisibilityProfileRecord,
  type VisibilityRunDetailRecord,
  type VisibilityRunRecord,
} from '@geomix/shared';
import { Alert, Button, Checkbox, Input, Space, Tooltip, Typography } from 'antd';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { GM, formatPct } from '../../lib/design-tokens';
import { NATIVE_SELECT_STYLE } from '../../lib/select-styles';
import { createVisibilityIdempotencyKey, type VisibilityGateway } from '../../lib/visibility';
import { CrudModal } from '../crud/crud-modal';
import type { CrudColumn } from '../crud/crud-table';
import { EngineChipList, SignalPill, StatusPill, TruncText } from '../geo/primitives';
import {
  ERROR_DOT_STYLE,
  PCT_TRACK_STYLE,
  PROGRESS_TRACK_STYLE,
  buildDefaultRunDraft,
  clampVisibilityPct,
  computeRunProgressPercents,
  countUniqueRunPrompts,
  formatTime,
  isControllableRunStatus,
  validateRunDraftForSubmit,
  type ConfirmDialogState,
  type RunCreateDraft,
  type RunModalState,
} from './monitors-helpers';

const ENGINE_GROUPS = [
  { groupLabel: '国内主流引擎', items: VISIBILITY_ENGINES.filter((eng) => eng.domestic) },
  { groupLabel: '海外搜索引擎', items: VISIBILITY_ENGINES.filter((eng) => !eng.domestic) },
] as const;

const QUESTIONS_BOX_STYLE: CSSProperties = {
  padding: 12,
  marginBottom: 12,
  borderRadius: 8,
  border: '1px solid var(--gm-line-1)',
  background: 'var(--gm-bg-surface)',
};
const FLEX_ROW_BETWEEN_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  marginBottom: 8,
};
const ENGINES_BOX_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: 12,
  borderRadius: 8,
  border: '1px solid var(--gm-line-1)',
  background: 'var(--gm-bg-surface)',
};
const GROUP_LABEL_STYLE: CSSProperties = {
  fontSize: 11,
  lineHeight: '16px',
  fontWeight: 500,
  letterSpacing: '0.06em',
  color: 'var(--gm-fg-3)',
  marginBottom: 6,
};

type RowActProps = { label: string; text: string; danger?: boolean; onClick: () => void };

function RowActBtn({ label, text, danger, onClick }: RowActProps) {
  return (
    <Button type="link" size="small" danger={danger} aria-label={label} onClick={onClick}>
      {text}
    </Button>
  );
}

export function buildMonitorsRunColumns({
  readOnly,
  onOpenDetail,
  onOpenOverview,
  onPauseRun,
  onResumeRun,
  onRequestConfirm,
}: {
  readOnly: boolean;
  onOpenDetail: (runId: string) => void;
  onOpenOverview: (profileId?: string) => void;
  onPauseRun: (row: VisibilityRunRecord) => void;
  onResumeRun: (row: VisibilityRunRecord) => void;
  onRequestConfirm: (dialog: ConfirmDialogState) => void;
}): CrudColumn<VisibilityRunRecord>[] {
  return [
    {
      key: 'name',
      title: '任务名称',
      width: 118,
      hideable: false,
      render: (row) => (
        <button type="button" className="gm-monitors-name-btn" onClick={() => onOpenDetail(row.id)}>
          <TruncText text={row.name} lines={1} />
        </button>
      ),
    },
    {
      key: 'profile',
      title: '监测档案 / 主品牌',
      width: 170,
      render: (row) => (
        <div
          data-testid={`run-profile-cell-${row.id}`}
          style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 168 }}
        >
          <span className="gm-clamp-1" style={{ fontSize: 13, color: 'var(--gm-fg-1)' }}>
            {row.profileName}
          </span>
          <span className="gm-clamp-1" style={{ fontSize: 12, color: 'var(--gm-fg-3)' }}>
            {row.brandName}
          </span>
        </div>
      ),
    },
    {
      key: 'keywordMain',
      title: '关联主词',
      width: 114,
      render: (row) => (
        <span
          data-testid={`run-keyword-cell-${row.id}`}
          className="gm-clamp-1"
          style={{
            display: 'inline-block',
            minWidth: 112,
            color: row.keywordMain ? 'var(--gm-fg-2)' : 'var(--gm-fg-3)',
          }}
        >
          {row.keywordMain ?? '—'}
        </span>
      ),
    },
    {
      key: 'engines',
      title: '监测引擎',
      width: 98,
      render: (row) => <EngineChipList engines={row.engines} max={2} />,
    },
    {
      key: 'progress',
      title: '检测进度',
      width: 74,
      render: (row) => {
        const { donePct, failPct, skipPct } = computeRunProgressPercents(row);
        return (
          <div style={{ width: 66 }}>
            <span className="gm-num" style={{ fontSize: 12, color: 'var(--gm-fg-1)' }}>
              {row.doneCount}/{row.totalChecks}
            </span>
            <div style={PROGRESS_TRACK_STYLE}>
              {row.totalChecks > 0 ? (
                <>
                  {donePct > 0 ? (
                    <div
                      style={{ width: `${donePct}%`, height: '100%', background: GM.sig.cited }}
                    />
                  ) : null}
                  {row.status === 'RUNNING' ? <div className="gm-progress-pulse" /> : null}
                  {failPct > 0 ? (
                    <div
                      style={{ width: `${failPct}%`, height: '100%', background: GM.status.danger }}
                    />
                  ) : null}
                  {skipPct > 0 ? (
                    <div style={{ width: `${skipPct}%`, height: '100%', background: GM.fg.f4 }} />
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
        );
      },
    },
    {
      key: 'visibilityPct',
      title: '品牌提及率',
      width: 84,
      render: (row) => {
        const pct = row.visibilityPct;
        const barWidth = clampVisibilityPct(pct);
        return (
          <div
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}
          >
            <span aria-hidden="true" style={PCT_TRACK_STYLE}>
              <span
                style={{
                  display: 'block',
                  width: `${barWidth}%`,
                  height: '100%',
                  background: GM.sig.cited,
                }}
              />
            </span>
            <span
              className="gm-num"
              style={{
                color: pct === null || pct === undefined ? 'var(--gm-fg-3)' : 'var(--gm-fg-1)',
              }}
            >
              {formatPct(pct)}
            </span>
          </div>
        );
      },
    },
    {
      key: 'points',
      title: '预冻 / 结算点数',
      width: 96,
      render: (row) => (
        <Tooltip title={`已退回 ${row.releasedPoints ?? 0} 点`}>
          <div
            className="gm-num"
            style={{ textAlign: 'right', fontSize: 12, whiteSpace: 'nowrap', minWidth: 80 }}
          >
            <div style={{ color: 'var(--gm-fg-1)' }}>预冻 {row.frozenPoints ?? 0} 点</div>
            <div style={{ color: 'var(--gm-fg-3)', fontSize: 11 }}>
              已结 {row.settledPoints ?? 0} 点
            </div>
          </div>
        </Tooltip>
      ),
    },
    {
      key: 'status',
      title: '状态',
      width: 74,
      render: (row) => (
        <span
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}
        >
          <StatusPill kind="task" status={row.status} />
          {row.lastError ? (
            <Tooltip title={row.lastError} styles={{ root: { maxWidth: 360 } }}>
              <span role="img" aria-label="任务异常详情" style={ERROR_DOT_STYLE}>
                !
              </span>
            </Tooltip>
          ) : null}
        </span>
      ),
    },
    {
      key: 'createdAt',
      title: '创建时间',
      width: 92,
      render: (row) => (
        <span
          className="gm-num"
          style={{
            display: 'inline-block',
            fontSize: 12,
            color: 'var(--gm-fg-3)',
            whiteSpace: 'normal',
            lineHeight: 1.35,
          }}
        >
          {formatTime(row.createdAt)}
        </span>
      ),
    },
    {
      key: 'actions',
      title: '操作',
      width: 136,
      hideable: false,
      render: (row) => (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, minWidth: 120 }}>
          <RowActBtn
            label={`查看详情-${row.name}`}
            text="查看详情"
            onClick={() => onOpenDetail(row.id)}
          />
          <RowActBtn
            label={`去看板分析-${row.name}`}
            text="去看板分析"
            onClick={() => onOpenOverview(row.profileId)}
          />
          {(row.status === 'QUEUED' || row.status === 'RUNNING') && !readOnly ? (
            <RowActBtn label={`暂停-${row.name}`} text="暂停" onClick={() => onPauseRun(row)} />
          ) : null}
          {row.status === 'PAUSED' && !readOnly ? (
            <RowActBtn label={`继续-${row.name}`} text="继续" onClick={() => onResumeRun(row)} />
          ) : null}
          {isControllableRunStatus(row.status) && !readOnly ? (
            <RowActBtn
              danger
              label={`终止-${row.name}`}
              text="终止"
              onClick={() => onRequestConfirm({ kind: 'cancel-run', run: row })}
            />
          ) : null}
          {!isControllableRunStatus(row.status) && !readOnly ? (
            <RowActBtn
              danger
              label={`删除-${row.name}`}
              text="删除"
              onClick={() => onRequestConfirm({ kind: 'delete-runs', ids: [row.id] })}
            />
          ) : null}
        </div>
      ),
    },
  ];
}

export type RunCreateModalProps = {
  open: boolean;
  session: number;
  initialProfileId: string;
  profiles: VisibilityProfileRecord[];
  keywords: KeywordRecord[];
  unitPoints: number;
  client: VisibilityGateway;
  readOnly?: boolean;
  onRefreshMeta: () => void;
  onClose: () => void;
  onCreated: (created: VisibilityRunDetailRecord) => void;
};

export function RunCreateModal({
  open,
  session,
  initialProfileId,
  profiles,
  keywords,
  unitPoints,
  client,
  readOnly = false,
  onRefreshMeta,
  onClose,
  onCreated,
}: RunCreateModalProps) {
  const sessionKey = open ? `${session}:${initialProfileId}` : null;

  const computeInitialDraft = () => {
    const targetProfile = profiles.find((p) => p.id === initialProfileId);
    const defaultKeywordId = resolveDefaultKeywordIdForProfile(keywords, targetProfile, profiles);
    return buildDefaultRunDraft(initialProfileId, defaultKeywordId);
  };

  const [activeSessionKey, setActiveSessionKey] = useState<string | null>(sessionKey);
  const [modalState, setModalState] = useState<RunModalState>(() => {
    const initial = computeInitialDraft();
    return {
      initial,
      draft: initial,
      idempotencyKey: createVisibilityIdempotencyKey('vrun'),
      minimized: false,
      maximized: false,
    };
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [keywordQuestions, setKeywordQuestions] = useState<QuestionRecord[]>([]);
  const [questionsLoading, setQuestionsLoading] = useState(false);
  const runKeywordSelectRef = useRef<HTMLSelectElement | null>(null);

  if (sessionKey !== activeSessionKey) {
    setActiveSessionKey(sessionKey);
    if (sessionKey !== null) {
      const initial = computeInitialDraft();
      setModalState({
        initial,
        draft: initial,
        idempotencyKey: createVisibilityIdempotencyKey('vrun'),
        minimized: false,
        maximized: false,
      });
      setError(null);
      setSubmitting(false);
      setKeywordQuestions([]);
      setQuestionsLoading(false);
    }
  }

  const { draft, idempotencyKey } = modalState;

  const activeModalProfile = useMemo(
    () => (draft.profileId ? profiles.find((p) => p.id === draft.profileId) : undefined),
    [draft.profileId, profiles],
  );
  const modalKeywords = useMemo(
    () => filterKeywordsForVisibilityProfile(keywords, activeModalProfile, profiles),
    [activeModalProfile, keywords, profiles],
  );

  useEffect(() => {
    if (!open || !draft.keywordId) return;
    if (!modalKeywords.some((kw) => kw.id === draft.keywordId)) {
      setModalState((curr) => {
        if (!curr.draft.keywordId || modalKeywords.some((kw) => kw.id === curr.draft.keywordId)) {
          return curr;
        }
        return {
          ...curr,
          draft: { ...curr.draft, keywordId: '', questionIds: [] },
          idempotencyKey: createVisibilityIdempotencyKey('vrun'),
        };
      });
    }
  }, [draft.keywordId, modalKeywords, open]);

  useEffect(() => {
    const el = runKeywordSelectRef.current;
    if (el && el.value !== draft.keywordId) el.value = draft.keywordId;
  }, [draft.keywordId, modalKeywords]);

  useEffect(() => {
    if (!open) return undefined;
    if (!draft.keywordId || !modalKeywords.some((kw) => kw.id === draft.keywordId)) {
      setKeywordQuestions([]);
      setQuestionsLoading(false);
      return undefined;
    }
    let cancelled = false;
    setQuestionsLoading(true);
    void client
      .listQuestionsByKeyword(draft.keywordId)
      .then((items) => {
        if (!cancelled) setKeywordQuestions(items);
      })
      .catch(() => {
        if (!cancelled) setKeywordQuestions([]);
      })
      .finally(() => {
        if (!cancelled) setQuestionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, draft.keywordId, modalKeywords, open]);

  function patchRunDraft(updater: (prev: RunCreateDraft) => RunCreateDraft) {
    setModalState((curr) => ({
      ...curr,
      draft: updater(curr.draft),
      idempotencyKey: createVisibilityIdempotencyKey('vrun'),
    }));
  }

  const runPromptCount = useMemo(
    () => (open ? countUniqueRunPrompts(draft, keywordQuestions) : 0),
    [draft, keywordQuestions, open],
  );
  const runEngineCount = open ? draft.engines.length : 0;
  const runTotalChecks = runPromptCount * runEngineCount;
  const runTotalPoints =
    runTotalChecks > 0 ? quoteVisibilityRunPoints(runTotalChecks, unitPoints).totalPoints : 0;

  async function handleSubmit() {
    if (!open || readOnly) return;
    setError(null);
    const validated = validateRunDraftForSubmit(draft);
    if (!validated.ok) {
      setError(validated.error);
      return;
    }
    const { customPrompts } = validated;

    setSubmitting(true);
    try {
      const created = await client.createRun(
        {
          profileId: draft.profileId,
          ...(draft.keywordId ? { keywordId: draft.keywordId } : {}),
          ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
          engines: draft.engines,
          questionIds: draft.questionIds,
          customPrompts,
        },
        idempotencyKey,
      );
      onCreated(created);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '发起监测任务失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <CrudModal
      open={open}
      title="新建 AI 可见度监测任务"
      minimized={modalState.minimized}
      maximized={modalState.maximized}
      confirmLoading={submitting}
      error={error}
      onMinimize={() => setModalState((curr) => ({ ...curr, minimized: true }))}
      onRestore={() => {
        setModalState((curr) => ({ ...curr, minimized: false }));
        onRefreshMeta();
      }}
      onMaximize={() => setModalState((curr) => ({ ...curr, maximized: !curr.maximized }))}
      onClose={() => {
        if (submitting) return;
        setError(null);
        onClose();
      }}
      onReset={() => {
        setError(null);
        setModalState((curr) => ({
          ...curr,
          draft: curr.initial,
          idempotencyKey: createVisibilityIdempotencyKey('vrun'),
        }));
      }}
      ok={
        <Button
          type="primary"
          aria-label={`开始监测（${unitPoints}点数/次，共 ${runTotalPoints} 点）`}
          loading={submitting}
          disabled={submitting}
          onClick={() => void handleSubmit()}
        >
          {`开始监测（${unitPoints}点数/次，共 ${runTotalPoints} 点）`}
        </Button>
      }
    >
      {open ? (
        <div className="gm-run-modal-body">
          <Alert
            type="info"
            showIcon
            className="gm-num"
            style={{ marginBottom: 14 }}
            message={`共 ${runPromptCount} 个问题 × ${runEngineCount} 个引擎 = ${runTotalChecks} 次检测，预计冻结 ${runTotalPoints} 点数（单价 ${unitPoints} 点/次，失败或终止未执行项自动退回）`}
          />

          <label>
            <span>
              <span className="gm-required-mark" style={{ color: 'var(--gm-danger)' }}>
                *{' '}
              </span>
              选择监测档案
            </span>
            <select
              aria-label="选择监测档案"
              style={NATIVE_SELECT_STYLE}
              value={draft.profileId}
              onChange={(e) => {
                const nextProfileId = e.target.value;
                const nextProfile = profiles.find((prof) => prof.id === nextProfileId);
                const nextDefaultKeywordId = resolveDefaultKeywordIdForProfile(
                  keywords,
                  nextProfile,
                  profiles,
                );
                patchRunDraft((prev) => ({
                  ...prev,
                  profileId: nextProfileId,
                  keywordId: nextDefaultKeywordId,
                  questionIds: [],
                }));
              }}
            >
              <option value="">请选择品牌监测档案</option>
              {profiles.map((prof) => (
                <option key={prof.id} value={prof.id}>
                  {prof.name}（主品牌：{prof.brandName}）
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>任务名称（留空自动按品牌+日期生成）</span>
            <Input
              aria-label="监测任务名称"
              placeholder="例如：便携显示器2026采购季多模型可见度诊断"
              maxLength={VISIBILITY_RUN_NAME_MAX}
              value={draft.name}
              onChange={(e) => patchRunDraft((prev) => ({ ...prev, name: e.target.value }))}
            />
          </label>

          <label>
            <span>关联训练主词（可选，选中后可勾选该主词下的写作标题作为监测问题）</span>
            <select
              ref={runKeywordSelectRef}
              aria-label="关联训练主词"
              style={NATIVE_SELECT_STYLE}
              value={draft.keywordId}
              onChange={(e) =>
                patchRunDraft((prev) => ({ ...prev, keywordId: e.target.value, questionIds: [] }))
              }
            >
              <option value="">不关联主词（仅使用下方自定义问题）</option>
              {modalKeywords.map((kw) => (
                <option key={kw.id} value={kw.id}>
                  {kw.main}
                </option>
              ))}
            </select>
            {draft.profileId && modalKeywords.length === 0 ? (
              <Typography.Text
                type="secondary"
                style={{ display: 'block', marginTop: 4, fontSize: 12 }}
              >
                当前监测档案暂无同品牌训练主词，可直接填写下方自定义监测问题。
              </Typography.Text>
            ) : null}
          </label>

          {draft.keywordId ? (
            <div style={QUESTIONS_BOX_STYLE}>
              <div style={FLEX_ROW_BETWEEN_STYLE}>
                <Typography.Text strong style={{ fontSize: 13 }}>
                  勾选待检测写作标题（已选 {draft.questionIds.length}/{keywordQuestions.length}）
                </Typography.Text>
                <Space size={6}>
                  <Button
                    size="small"
                    aria-label="全选当前主词问题"
                    disabled={keywordQuestions.length === 0}
                    onClick={() =>
                      patchRunDraft((prev) => ({
                        ...prev,
                        questionIds: keywordQuestions.map((q) => q.id),
                      }))
                    }
                  >
                    全选
                  </Button>
                  <Button
                    size="small"
                    aria-label="清空已选问题"
                    disabled={draft.questionIds.length === 0}
                    onClick={() => patchRunDraft((prev) => ({ ...prev, questionIds: [] }))}
                  >
                    清空
                  </Button>
                </Space>
              </div>

              {questionsLoading ? (
                <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                  正在加载主词关联问题…
                </Typography.Text>
              ) : keywordQuestions.length === 0 ? (
                <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                  该主词下暂无写作标题，请在下方直接输入自定义监测问题。
                </Typography.Text>
              ) : (
                <div style={{ display: 'grid', gap: 6, maxHeight: 168, overflowY: 'auto' }}>
                  {keywordQuestions.map((q) => {
                    const checked = draft.questionIds.includes(q.id);
                    return (
                      <Checkbox
                        key={q.id}
                        checked={checked}
                        onChange={(e) => {
                          const nextChecked = e.target.checked;
                          patchRunDraft((prev) => ({
                            ...prev,
                            questionIds: nextChecked
                              ? [...prev.questionIds, q.id]
                              : prev.questionIds.filter((id) => id !== q.id),
                          }));
                        }}
                      >
                        <span>{q.text}</span>
                        {q.included ? (
                          <span style={{ marginInlineStart: 6 }}>
                            <SignalPill tone="cited">已收录</SignalPill>
                          </span>
                        ) : null}
                      </Checkbox>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}

          <label>
            <span>自定义监测问题（每行一条，支持与上方勾选标题同时提交）</span>
            <Input.TextArea
              aria-label="自定义监测问题"
              rows={4}
              style={{ maxHeight: 160, overflow: 'auto' }}
              placeholder={
                '2026年出差办公便携显示器推荐哪几款？\n4K触控便携屏哪个品牌色彩准确且售后稳定？'
              }
              value={draft.customPromptsText}
              onChange={(e) =>
                patchRunDraft((prev) => ({ ...prev, customPromptsText: e.target.value }))
              }
            />
          </label>

          <div style={{ marginBottom: 8 }}>
            <div style={FLEX_ROW_BETWEEN_STYLE}>
              <Typography.Text strong>
                <span className="gm-required-mark" style={{ color: 'var(--gm-danger)' }}>
                  *{' '}
                </span>
                目标 AI 引擎（已选 {draft.engines.length} 个）
              </Typography.Text>
              <Space size={6} wrap>
                <Button
                  size="small"
                  aria-label="全选国内8大引擎"
                  onClick={() =>
                    patchRunDraft((prev) => ({
                      ...prev,
                      engines: [...DOMESTIC_VISIBILITY_ENGINE_KEYS],
                    }))
                  }
                >
                  全选国内8大引擎
                </Button>
                <Button
                  size="small"
                  aria-label="全选全部引擎"
                  onClick={() =>
                    patchRunDraft((prev) => ({
                      ...prev,
                      engines: VISIBILITY_ENGINES.map((item) => item.key),
                    }))
                  }
                >
                  全选全部引擎
                </Button>
                <Button
                  size="small"
                  aria-label="清空引擎选择"
                  onClick={() => patchRunDraft((prev) => ({ ...prev, engines: [] }))}
                >
                  清空
                </Button>
              </Space>
            </div>

            <div style={ENGINES_BOX_STYLE}>
              {ENGINE_GROUPS.map((group) => (
                <div key={group.groupLabel}>
                  <div style={GROUP_LABEL_STYLE}>{group.groupLabel}</div>
                  <div className="gm-engine-grid">
                    {group.items.map((eng) => {
                      const checked = draft.engines.includes(eng.key);
                      return (
                        <div
                          key={eng.key}
                          className={
                            checked ? 'gm-engine-card gm-engine-card-checked' : 'gm-engine-card'
                          }
                        >
                          <Checkbox
                            aria-label={`选择引擎-${eng.label}`}
                            checked={checked}
                            onChange={(e) => {
                              const nextChecked = e.target.checked;
                              patchRunDraft((prev) => ({
                                ...prev,
                                engines: nextChecked
                                  ? [...prev.engines, eng.key]
                                  : prev.engines.filter((k) => k !== eng.key),
                              }));
                            }}
                          >
                            <span>{eng.label}</span>
                          </Checkbox>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </CrudModal>
  );
}
