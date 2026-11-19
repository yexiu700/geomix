'use client';

import { Button, Input, Typography } from 'antd';
import dynamic from 'next/dynamic';
import { DashboardScreen } from '../dashboard/dashboard-screen';
import { SignalSkeleton } from '../geo/primitives';
import { MODULE_PLACEHOLDER } from '../../lib/shell-copy';
import { matchRoute } from '../../lib/routes';
import type { SessionStorageLike } from '../../lib/session';
import type { ShellAction, ShellTab } from '../../lib/tab-stack';

function ModuleLoading() {
  return (
    <div style={{ padding: '16px 0' }} role="status" aria-label="正在加载模块">
      <SignalSkeleton variant="block" height={240} />
    </div>
  );
}

const MoneyScreen = dynamic(() => import('../account/money-screen').then((m) => m.MoneyScreen), {
  loading: ModuleLoading,
});
const PointsScreen = dynamic(() => import('../account/points-screen').then((m) => m.PointsScreen), {
  loading: ModuleLoading,
});
const RightsScreen = dynamic(() => import('../account/rights-screen').then((m) => m.RightsScreen), {
  loading: ModuleLoading,
});
const VerifyScreen = dynamic(() => import('../account/verify-screen').then((m) => m.VerifyScreen), {
  loading: ModuleLoading,
});
const SampleScreen = dynamic(() => import('../crud/sample-screen').then((m) => m.SampleScreen), {
  loading: ModuleLoading,
});
const AiImageScreen = dynamic(
  () => import('../image/ai-image-screen').then((m) => m.AiImageScreen),
  { loading: ModuleLoading },
);
const GalleryAssetScreen = dynamic(
  () => import('../material/gallery-screen').then((m) => m.GalleryAssetScreen),
  { loading: ModuleLoading },
);
const GalleryCategoryScreen = dynamic(
  () => import('../material/gallery-screen').then((m) => m.GalleryCategoryScreen),
  { loading: ModuleLoading },
);
const KeywordScreen = dynamic(
  () => import('../material/keyword-screen').then((m) => m.KeywordScreen),
  { loading: ModuleLoading },
);
const KnowledgeScreen = dynamic(
  () => import('../material/knowledge-screen').then((m) => m.KnowledgeScreen),
  { loading: ModuleLoading },
);
const QuestionScreen = dynamic(
  () => import('../material/question-screen').then((m) => m.QuestionScreen),
  { loading: ModuleLoading },
);
const RewriteBatchScreen = dynamic(
  () => import('../rewrite/rewrite-batch-screen').then((m) => m.RewriteBatchScreen),
  { loading: ModuleLoading },
);
const RewriteSingleScreen = dynamic(
  () => import('../rewrite/rewrite-single-screen').then((m) => m.RewriteSingleScreen),
  { loading: ModuleLoading },
);
const ArticleManageScreen = dynamic(
  () => import('../writing/article-manage-screen').then((m) => m.ArticleManageScreen),
  { loading: ModuleLoading },
);
const AiTaskScreen = dynamic(
  () => import('../writing/ai-task-screen').then((m) => m.AiTaskScreen),
  {
    loading: ModuleLoading,
  },
);
const CategoryScreen = dynamic(
  () => import('../writing/category-screen').then((m) => m.CategoryScreen),
  { loading: ModuleLoading },
);
const PromptScreen = dynamic(() => import('../writing/prompt-screen').then((m) => m.PromptScreen), {
  loading: ModuleLoading,
});
const VisibilityMonitorsScreen = dynamic(
  () => import('../visibility/visibility-monitors-screen').then((m) => m.VisibilityMonitorsScreen),
  { loading: ModuleLoading },
);
const VisibilityOverviewScreen = dynamic(
  () => import('../visibility/visibility-overview-screen').then((m) => m.VisibilityOverviewScreen),
  { loading: ModuleLoading },
);

export function ModuleScreen({
  tab,
  draft,
  active = true,
  readOnly = false,
  aiImageEnabled = true,
  visibilityEnabled = true,
  storage,
  onDispatch,
}: {
  tab: ShellTab;
  draft: string;
  active?: boolean;
  readOnly?: boolean;
  aiImageEnabled?: boolean;
  visibilityEnabled?: boolean;
  storage?: SessionStorageLike;
  onDispatch: (action: ShellAction) => void;
}) {
  const path = matchRoute(tab.href)?.path ?? '';
  if (path === '/dashboard') {
    return (
      <div>
        <DashboardScreen
          title={tab.title}
          tabId={tab.id}
          active={active}
          aiImageEnabled={aiImageEnabled}
          visibilityEnabled={visibilityEnabled}
          onDispatch={onDispatch}
        />
        <TabDraftNote tab={tab} draft={draft} onDispatch={onDispatch} />
      </div>
    );
  }
  if (path === '/workbench/samples' && process.env.NODE_ENV !== 'production') {
    return <SampleScreen title={tab.title} readOnly={readOnly} />;
  }
  if (path === '/writing/categories') {
    return (
      <CategoryScreen
        title={tab.title}
        tabId={tab.id}
        active={active}
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
          active={active}
          readOnly={readOnly}
          onDispatch={onDispatch}
        />
        <TabDraftNote tab={tab} draft={draft} onDispatch={onDispatch} />
      </div>
    );
  }
  if (path === '/me/points') return <PointsScreen title={tab.title} active={active} />;
  if (path === '/me/money') return <MoneyScreen title={tab.title} active={active} />;
  if (path === '/me/rights') return <RightsScreen title={tab.title} active={active} />;
  if (path === '/me/verify') return <VerifyScreen title={tab.title} readOnly={readOnly} />;
  if (path === '/material/keywords') {
    return (
      <div>
        <KeywordScreen
          title={tab.title}
          tabId={tab.id}
          active={active}
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
          active={active}
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
          active={active}
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
          href={tab.href}
          active={active}
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
          active={active}
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
          active={active}
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
          active={active}
          readOnly={readOnly}
          featureEnabled={aiImageEnabled}
          onDispatch={onDispatch}
        />
        <TabDraftNote tab={tab} draft={draft} onDispatch={onDispatch} />
      </div>
    );
  }
  if (path === '/visibility/monitors') {
    return (
      <div>
        <VisibilityMonitorsScreen
          title={tab.title}
          tabId={tab.id}
          href={tab.href}
          active={active}
          readOnly={readOnly}
          featureEnabled={visibilityEnabled}
          storage={storage}
          onDispatch={onDispatch}
        />
        <TabDraftNote tab={tab} draft={draft} onDispatch={onDispatch} />
      </div>
    );
  }
  if (path === '/visibility/overview') {
    return (
      <div>
        <VisibilityOverviewScreen
          title={tab.title}
          tabId={tab.id}
          href={tab.href}
          active={active}
          readOnly={readOnly}
          featureEnabled={visibilityEnabled}
          storage={storage}
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
        className="gm-draft-note"
        aria-label={`${tab.title}草稿`}
        value={draft}
        rows={2}
        placeholder="本页草稿便签（切换标签页自动保留）"
        onChange={(event) => onDispatch({ type: 'draft', id: tab.id, value: event.target.value })}
      />
    </div>
  );
}
