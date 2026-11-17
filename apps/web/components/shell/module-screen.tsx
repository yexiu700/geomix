'use client';

import { Button, Input, Typography } from 'antd';
import { MoneyScreen } from '../account/money-screen';
import { PointsScreen } from '../account/points-screen';
import { RightsScreen } from '../account/rights-screen';
import { VerifyScreen } from '../account/verify-screen';
import { SampleScreen } from '../crud/sample-screen';
import { AiImageScreen } from '../image/ai-image-screen';
import { GalleryAssetScreen, GalleryCategoryScreen } from '../material/gallery-screen';
import { KeywordScreen } from '../material/keyword-screen';
import { KnowledgeScreen } from '../material/knowledge-screen';
import { QuestionScreen } from '../material/question-screen';
import { RewriteBatchScreen } from '../rewrite/rewrite-batch-screen';
import { RewriteSingleScreen } from '../rewrite/rewrite-single-screen';
import { ArticleManageScreen } from '../writing/article-manage-screen';
import { AiTaskScreen } from '../writing/ai-task-screen';
import { CategoryScreen } from '../writing/category-screen';
import { PromptScreen } from '../writing/prompt-screen';
import { MODULE_PLACEHOLDER } from '../../lib/shell-copy';
import { matchRoute } from '../../lib/routes';
import type { ShellAction, ShellTab } from '../../lib/tab-stack';

export function ModuleScreen({
  tab,
  draft,
  readOnly = false,
  aiImageEnabled = true,
  onDispatch,
}: {
  tab: ShellTab;
  draft: string;
  readOnly?: boolean;
  aiImageEnabled?: boolean;
  onDispatch: (action: ShellAction) => void;
}) {
  const path = matchRoute(tab.href)?.path ?? '';
  if (path === '/workbench/samples') {
    return <SampleScreen title={tab.title} readOnly={readOnly} />;
  }
  if (path === '/writing/categories') {
    return (
      <CategoryScreen
        title={tab.title}
        tabId={tab.id}
        readOnly={readOnly}
        onDispatch={onDispatch}
      />
    );
  }
  if (path === '/writing/articles') {
    return (
      <div>
        <ArticleManageScreen
          title={tab.title}
          tabId={tab.id}
          href={tab.href}
          readOnly={readOnly}
          onDispatch={onDispatch}
        />
        <TabDraftNote tab={tab} draft={draft} onDispatch={onDispatch} />
      </div>
    );
  }
  if (path === '/me/points') return <PointsScreen title={tab.title} />;
  if (path === '/me/money') return <MoneyScreen title={tab.title} />;
  if (path === '/me/rights') return <RightsScreen title={tab.title} />;
  if (path === '/me/verify') return <VerifyScreen title={tab.title} readOnly={readOnly} />;
  if (path === '/material/keywords') {
    return (
      <div>
        <KeywordScreen
          title={tab.title}
          tabId={tab.id}
          readOnly={readOnly}
          onDispatch={onDispatch}
        />
        <TabDraftNote tab={tab} draft={draft} onDispatch={onDispatch} />
      </div>
    );
  }
  if (path === '/material/questions') {
    return (
      <div>
        <QuestionScreen
          title={tab.title}
          tabId={tab.id}
          href={tab.href}
          readOnly={readOnly}
          onDispatch={onDispatch}
        />
        <TabDraftNote tab={tab} draft={draft} onDispatch={onDispatch} />
      </div>
    );
  }
  if (path === '/material/gallery') {
    return (
      <div>
        <GalleryCategoryScreen
          title={tab.title}
          tabId={tab.id}
          readOnly={readOnly}
          onDispatch={onDispatch}
        />
        <TabDraftNote tab={tab} draft={draft} onDispatch={onDispatch} />
      </div>
    );
  }
  if (path.startsWith('/material/gallery/')) {
    const categoryId = path.slice('/material/gallery/'.length);
    return (
      <div>
        <GalleryAssetScreen
          title={tab.title}
          tabId={tab.id}
          categoryId={categoryId}
          readOnly={readOnly}
          onDispatch={onDispatch}
        />
        <TabDraftNote tab={tab} draft={draft} onDispatch={onDispatch} />
      </div>
    );
  }
  if (path === '/material/knowledge') {
    return (
      <div>
        <KnowledgeScreen title={tab.title} readOnly={readOnly} />
        <TabDraftNote tab={tab} draft={draft} onDispatch={onDispatch} />
      </div>
    );
  }
  if (path === '/writing/prompts') {
    return (
      <div>
        <PromptScreen title={tab.title} readOnly={readOnly} />
        <TabDraftNote tab={tab} draft={draft} onDispatch={onDispatch} />
      </div>
    );
  }
  if (path === '/writing/tasks') {
    return (
      <div>
        <AiTaskScreen
          title={tab.title}
          tabId={tab.id}
          readOnly={readOnly}
          onDispatch={onDispatch}
        />
        <TabDraftNote tab={tab} draft={draft} onDispatch={onDispatch} />
      </div>
    );
  }
  if (path === '/rewrite/single') {
    return (
      <div>
        <RewriteSingleScreen
          title={tab.title}
          tabId={tab.id}
          readOnly={readOnly}
          onDispatch={onDispatch}
        />
        <TabDraftNote tab={tab} draft={draft} onDispatch={onDispatch} />
      </div>
    );
  }
  if (path === '/rewrite/batch') {
    return (
      <div>
        <RewriteBatchScreen
          title={tab.title}
          tabId={tab.id}
          readOnly={readOnly}
          onDispatch={onDispatch}
        />
        <TabDraftNote tab={tab} draft={draft} onDispatch={onDispatch} />
      </div>
    );
  }
  if (path === '/image') {
    return (
      <div>
        <AiImageScreen
          title={tab.title}
          tabId={tab.id}
          readOnly={readOnly}
          featureEnabled={aiImageEnabled}
          onDispatch={onDispatch}
        />
        <TabDraftNote tab={tab} draft={draft} onDispatch={onDispatch} />
      </div>
    );
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
      {canGoBack ? (
        <Button style={{ marginTop: 16 }} onClick={() => onDispatch({ type: 'back', id: tab.id })}>
          返回上一级
        </Button>
      ) : null}
    </section>
  );
}

export function TabDraftNote({
  tab,
  draft,
  onDispatch,
}: {
  tab: ShellTab;
  draft: string;
  onDispatch: (action: ShellAction) => void;
}) {
  return (
    <div style={{ marginTop: 16 }}>
      <Input.TextArea
        aria-label={`${tab.title}草稿`}
        value={draft}
        rows={2}
        placeholder="本页草稿便签（切换标签页自动保留）"
        onChange={(event) => onDispatch({ type: 'draft', id: tab.id, value: event.target.value })}
      />
    </div>
  );
}
