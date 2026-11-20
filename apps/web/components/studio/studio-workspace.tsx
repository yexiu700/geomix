'use client';

import { WorkspacePlaceholder } from '../shell/workspace-placeholder';

export function StudioWorkspace() {
  return (
    <WorkspacePlaceholder
      workspaceTitle="GEO 靶向写作台"
      subtitle="三栏流式精写画布，统一 10 点/篇免费标配品牌事实卡，支持 4 大 GEO 配方、双轨合规与即发交付闭环。"
      highlights={[
        {
          title: '实时流式精写与 4 大配方',
          badge: '10 点/篇',
          description:
            '支持权威选购指南、竞品公平对照评测、痛点澄清答疑与高引用信源超越稿，并随市场切换国内/海外目标阵地形态。',
        },
        {
          title: '跨语种事实注入与双轨合规',
          badge: 'CN / FTC',
          description:
            '海外市场自动将中文品牌事实卡跨语种注入生成地道英文 GEO 稿，并切换 FTC 客观规范保留 Best / Top 等高意图选购词。',
        },
        {
          title: 'GEO 0–100 体检与发布复测',
          badge: '免费体检',
          description:
            '实时输出 5 维引用就绪度评分、Markdown / HTML / DOCX 与 JSON-LD / llms.txt 导出包，登记发布 URL 后一键复测排名变化。',
        },
      ]}
    />
  );
}
