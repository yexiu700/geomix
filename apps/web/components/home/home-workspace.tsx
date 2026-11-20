'use client';

import { WorkspacePlaceholder } from '../shell/workspace-placeholder';

export function HomeWorkspace() {
  return (
    <WorkspacePlaceholder
      workspaceTitle="行动首页"
      subtitle="聚焦当前品牌与目标市场的 AI 可见度健康信号、今日 Top 3 优先写作建议与近期复测进展。"
      highlights={[
        {
          title: '品牌健康信号条',
          badge: '14 天隔离指标',
          description:
            '按当前激活的品牌与市场独立统计 AI 提及率、声量占比 SoV、平均顺位与自有阵地引用率，杜绝跨品牌跨市场混算。',
        },
        {
          title: '今日 Top 3 优先写作建议',
          badge: '0 点免费诊断',
          description:
            '按竞品霸榜缺口、负面情感风险与低顺位自动排序，支持滑出诊断意见抽屉或一键带上下文直达 GEO 写作台。',
        },
        {
          title: '近期成稿与复测闭环',
          badge: 'Before → After',
          description:
            '汇总最近 5 篇 GEO 成稿的引用就绪度评分、已发布链接与一键复测后的排名变化对比。',
        },
      ]}
    />
  );
}
