'use client';

import { Button, Input, Space, Typography } from 'antd';
import { useState } from 'react';
import { SampleScreen } from '../crud/sample-screen';
import { MODULE_PLACEHOLDER } from '../../lib/shell-copy';
import { matchRoute } from '../../lib/routes';
import type { ShellAction, ShellTab } from '../../lib/tab-stack';

export function ModuleScreen({
  tab,
  draft,
  readOnly = false,
  onDispatch,
}: {
  tab: ShellTab;
  draft: string;
  readOnly?: boolean;
  onDispatch: (action: ShellAction) => void;
}) {
  const path = matchRoute(tab.href)?.path ?? '';
  if (path === '/workbench/samples') {
    return <SampleScreen title={tab.title} readOnly={readOnly} />;
  }
  const canGoBack = Boolean(tab.sourceId || matchRoute(tab.href)?.parent);

  return (
    <section>
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        {tab.title}
      </Typography.Title>
      <Typography.Paragraph type="secondary">{MODULE_PLACEHOLDER}</Typography.Paragraph>
      <Input.TextArea
        aria-label={`${tab.title}草稿`}
        value={draft}
        rows={5}
        placeholder="在这里写的内容会随标签保留"
        onChange={(event) => onDispatch({ type: 'draft', id: tab.id, value: event.target.value })}
      />
      {path === '/material/keywords' ? (
        <KeywordDrill tabId={tab.id} onDispatch={onDispatch} />
      ) : null}
      {path === '/material/gallery' ? (
        <GalleryDrill tabId={tab.id} onDispatch={onDispatch} />
      ) : null}
      {canGoBack ? (
        <Button style={{ marginTop: 16 }} onClick={() => onDispatch({ type: 'back', id: tab.id })}>
          返回上一级
        </Button>
      ) : null}
    </section>
  );
}

function KeywordDrill({
  tabId,
  onDispatch,
}: {
  tabId: string;
  onDispatch: (action: ShellAction) => void;
}) {
  const [keywordId, setKeywordId] = useState('demo');
  return (
    <Space style={{ marginTop: 16 }} wrap>
      <Input
        aria-label="主词编号"
        value={keywordId}
        onChange={(event) => setKeywordId(event.target.value)}
        style={{ width: 180 }}
      />
      <Button
        type="primary"
        onClick={() => {
          const value = keywordId.trim();
          if (!value) return;
          onDispatch({
            type: 'open',
            href: `/material/questions?keywordId=${encodeURIComponent(value)}`,
            sourceId: tabId,
          });
        }}
      >
        查看写作标题
      </Button>
    </Space>
  );
}

function GalleryDrill({
  tabId,
  onDispatch,
}: {
  tabId: string;
  onDispatch: (action: ShellAction) => void;
}) {
  const [assetId, setAssetId] = useState('pic_1');
  return (
    <Space style={{ marginTop: 16 }} wrap>
      <Input
        aria-label="图片编号"
        value={assetId}
        onChange={(event) => setAssetId(event.target.value)}
        style={{ width: 180 }}
      />
      <Button
        onClick={() => {
          const value = assetId.trim();
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) return;
          onDispatch({
            type: 'open',
            href: `/material/gallery/${value}`,
            sourceId: tabId,
          });
        }}
      >
        查看图片
      </Button>
    </Space>
  );
}
