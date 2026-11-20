'use client';

import { WorkspacePlaceholder } from '../shell/workspace-placeholder';

export function BrandsWorkspace() {
  return (
    <WorkspacePlaceholder
      workspaceTitle="品牌资产"
      subtitle="维护品牌身份、双市场竞品域名、4 块结构化品牌事实卡与真实产品实拍图库，作为全站免费标配事实底座。"
      highlights={[
        {
          title: '双市场品牌身份与竞品雷达',
          badge: 'CN / GLOBAL',
          description:
            '同一品牌下按国内与海外市场独立配置当地品牌名、别名、自有官网域名、竞品域名与监控种子问句。',
        },
        {
          title: '4 块结构化品牌事实卡',
          badge: 'AI 免费提炼',
          description:
            '支持粘贴官网链接或上传产品文档自动提炼核心参数、差异化卖点、资质背书与真实案例，超长补充资料自动后台建库。',
        },
        {
          title: '真实产品实拍图库',
          badge: '单层平铺管理',
          description:
            '直接拖拽上传真实产品实拍图并维护图片说明，在 GEO 写作台编辑器内按需免费插入，双市场自动共享。',
        },
      ]}
    />
  );
}
