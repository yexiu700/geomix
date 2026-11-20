'use client';

import { WorkspacePlaceholder } from '../shell/workspace-placeholder';

export function VisibilityWorkspace() {
  return (
    <WorkspacePlaceholder
      workspaceTitle="可见度诊断"
      subtitle="单品牌双市场严格隔离的 3 Tab 诊断工作区，串联国内 8 引擎 / 海外 5 引擎监测与免费写作意见引擎。"
      highlights={[
        {
          title: '诊断总览与写作建议',
          badge: 'Tab 1',
          description:
            '展示品牌与竞品声量对比、情感分布及全量待处理 GEO 写作意见，支持单条一键写作或勾选 2–20 条轻量批量生成。',
        },
        {
          title: '监测任务与问答透视',
          badge: 'Tab 2',
          description:
            '默认仅预选已上线健康引擎并明示未上线渠道，任意单条 AI 回答均可点击生成免费 GEO 写作意见抽屉。',
        },
        {
          title: '信源阵地与竞品洞察',
          badge: 'Tab 3',
          description:
            '识别自有官网、竞品官网、社媒社区、垂类评测与电商信源，支持高引用竞品页一键反制重写与拆解词专题聚类。',
        },
      ]}
    />
  );
}
