import { formatMoney } from './account';
import type { BillingMode } from './infra';

/**
 * 首页（Issue #22）共享常量、近 5 日按天统计纯函数与月度流水对账辅助函数。
 *
 * 合规与设计要点：
 * - 所有时间按 Asia/Shanghai（UTC+8）自然日切分，与个人中心点数明细/余额明细展示口径完全一致；
 * - 趋势严格统计近 5 日（而非 7 日或 30 日），仅统计 AI 写作（AI_TASK）与爆文复刻（REWRITE_SINGLE / REWRITE_BATCH）；
 * - 功能入口严格对应真实菜单结构，一期未开放的二期模块统一标「即将上线」，不虚构入口卡片；
 * - 播报条与充值说明均为 GeoMix 自写文案。
 */

export const DASHBOARD_TREND_DAYS = 5 as const;

export const DASHBOARD_RECHARGE_NOTICE = {
  money: '在线充值暂未开放，如需开通或补充账户余额请联系平台管理员处理。',
  points: '在线购点暂未开放，如需补充可用点数请联系平台管理员为您加点。',
} as const;

export const DASHBOARD_DEFAULT_ANNOUNCEMENTS = [
  {
    id: 'default-compliance',
    content: 'GeoMix 公告：请使用企业自有或取得合法授权的品牌、图文与知识库资料开展内容创作。',
    sort: 1,
  },
  {
    id: 'default-billing',
    content:
      'GeoMix 提示：账户点数与余额变动均可在「个人中心」逐笔对账；如需加点或续期请联系管理员。',
    sort: 2,
  },
] as const;

export type DashboardStatKey =
  | 'keywords'
  | 'questions'
  | 'mediaAssets'
  | 'knowledgeBases'
  | 'prompts'
  | 'articleCategories'
  | 'aiTasks'
  | 'articles'
  | 'rewriteSingle'
  | 'rewriteBatches'
  | 'aiImages';

export type DashboardModuleStats = Record<DashboardStatKey, number>;

export type DashboardEntryCardDef = {
  key: string;
  group: '素材源力' | '文章写作' | '流量复刻' | 'AI生图/视频' | '二期规划';
  title: string;
  desc: string;
  href: string | null;
  comingSoon: boolean;
  badge?: '新上' | '即将上线';
  statKey?: DashboardStatKey;
  statUnit?: string;
  featureFlag?: 'aiImage';
};

/**
 * 与侧边栏 MENU 严格对齐的功能入口卡片定义，不编造菜单以外的卡片。
 */
export const DASHBOARD_ENTRY_CARDS: readonly DashboardEntryCardDef[] = [
  // 素材源力
  {
    key: 'keywords',
    group: '素材源力',
    title: '关键词',
    desc: '训练主词、AI 蒸馏拓展与批量组合词包管理',
    href: '/material/keywords',
    comingSoon: false,
    statKey: 'keywords',
    statUnit: '个主词',
  },
  {
    key: 'questions',
    group: '素材源力',
    title: '写作标题',
    desc: '咨询问题池管理、去重添加与使用频次跟踪',
    href: '/material/questions',
    comingSoon: false,
    statKey: 'questions',
    statUnit: '条标题',
  },
  {
    key: 'gallery',
    group: '素材源力',
    title: '企业画像图库',
    desc: '企业实景与产品素材分组压缩存储，供写作与改写配图',
    href: '/material/gallery',
    comingSoon: false,
    statKey: 'mediaAssets',
    statUnit: '张素材',
  },
  {
    key: 'knowledge',
    group: '素材源力',
    title: '企业知识库',
    desc: '细分事实卡与长文本向量知识库，约束真实创作边界',
    href: '/material/knowledge',
    comingSoon: false,
    statKey: 'knowledgeBases',
    statUnit: '个知识库',
  },
  // 文章写作
  {
    key: 'prompts',
    group: '文章写作',
    title: '写作指令',
    desc: '正文、标题与流量复刻提示词模板查看、克隆及自建',
    href: '/writing/prompts',
    comingSoon: false,
    statKey: 'prompts',
    statUnit: '条自建',
  },
  {
    key: 'categories',
    group: '文章写作',
    title: '文章分类',
    desc: '按主题归档文章并实时统计正常未发送剩余篇数',
    href: '/writing/categories',
    comingSoon: false,
    statKey: 'articleCategories',
    statUnit: '个分类',
  },
  {
    key: 'tasks',
    group: '文章写作',
    title: 'AI写作任务',
    desc: '整单预冻、多篇并发异步创作与知识库事实注入',
    href: '/writing/tasks',
    comingSoon: false,
    statKey: 'aiTasks',
    statUnit: '个任务',
  },
  {
    key: 'articles',
    group: '文章写作',
    title: '文章列表',
    desc: '富文本审校、手动撰稿、批量审核与多格式压缩包导出',
    href: '/writing/articles',
    comingSoon: false,
    statKey: 'articles',
    statUnit: '篇文章',
  },
  // 流量复刻
  {
    key: 'rewrite-single',
    group: '流量复刻',
    title: '全网爆文复刻',
    desc: '公开网页正文提取或粘贴原文，合规重组并插入自有配图',
    href: '/rewrite/single',
    comingSoon: false,
    statKey: 'rewriteSingle',
    statUnit: '条记录',
  },
  {
    key: 'rewrite-batch',
    group: '流量复刻',
    title: '批量爆文复刻',
    desc: '链接清单与搜索候选批量改写，凑满即停并自动退还差额',
    href: '/rewrite/batch',
    comingSoon: false,
    statKey: 'rewriteBatches',
    statUnit: '个批次',
  },
  // AI生图/视频（受 FEATURE_AI_IMAGE 控制）
  {
    key: 'image',
    group: 'AI生图/视频',
    title: 'AI生图',
    desc: '9 种商业比例、免费扩写与一键零拷贝转存企业画像图库',
    href: '/image',
    comingSoon: false,
    badge: '新上',
    statKey: 'aiImages',
    statUnit: '笔订单',
    featureFlag: 'aiImage',
  },
  // 二期规划模块（与侧边栏即将上线项严格对应，不编造额外入口）
  {
    key: 'publish-soon',
    group: '二期规划',
    title: '文章发布',
    desc: '多平台账号授权与定时分发回执管理',
    href: null,
    comingSoon: true,
    badge: '即将上线',
  },
  {
    key: 'aidata-soon',
    group: '二期规划',
    title: 'AI数据',
    desc: 'AI 搜索收录监测与多维投放效果报表',
    href: null,
    comingSoon: true,
    badge: '即将上线',
  },
  {
    key: 'visibility-soon',
    group: '二期规划',
    title: 'AI可见度诊断',
    desc: '主流大模型问答提及率与品牌可见度评估',
    href: null,
    comingSoon: true,
    badge: '即将上线',
  },
  {
    key: 'tools-soon',
    group: '二期规划',
    title: 'AI工具',
    desc: '关键词指数查询、AI 拓词与手动拓词工具集',
    href: null,
    comingSoon: true,
    badge: '即将上线',
  },
] as const;

export type DashboardTrendDay = {
  /** YYYY-MM-DD（Asia/Shanghai） */
  date: string;
  /** MM-DD */
  label: string;
  /** 当日 AI 写作篇数（Article.source === 'AI_TASK'） */
  writingCount: number;
  /** 当日爆文复刻篇数（Article.source in ['REWRITE_SINGLE', 'REWRITE_BATCH']） */
  rewriteCount: number;
  /** 当日合计创作篇数 */
  totalCount: number;
};

export type DashboardAnnouncementItem = {
  id: string;
  content: string;
  sort: number;
};

export type DashboardSummary = {
  generatedAt: string;
  monthKey: string;
  tenant: {
    id: string;
    name: string;
    expiresAt: string;
    isActive: boolean;
    readOnly: boolean;
  };
  features: {
    aiImage: boolean;
  };
  balanceCard: {
    balance: string;
    monthConsumed: string;
    monthRecharged: string;
    rechargeNotice: string;
  };
  pointsCard: {
    billingMode: BillingMode;
    billingModeSource: 'tenant' | 'global';
    points: number;
    pointsReserved: number;
    available: number;
    /** 本月实际扣减点数（STRICT 下为正整数消耗额；SHADOW 下为 0，与点数明细 delta 完全一致） */
    monthConsumedPoints: number;
    /** 本月已结算消费项原价合计（含 SHADOW 免费期原价核算，与点数明细 listPrice 对齐） */
    monthListPricePoints: number;
    /** 本月管理员充值加点合计 */
    monthRechargedPoints: number;
    rechargeNotice: string;
  };
  announcements: DashboardAnnouncementItem[];
  trend5d: DashboardTrendDay[];
  stats: DashboardModuleStats;
};

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 将任意时间转换为 Asia/Shanghai（UTC+8）下的 YYYY-MM-DD 字符串。
 */
export function toShanghaiDateKey(input: Date | string): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) {
    throw new Error('无效的时间戳');
  }
  const shifted = new Date(d.getTime() + SHANGHAI_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 计算以 now 所在上海自然日为终点的近 5 日窗口（含首尾 UTC 边界与严格 5 个升序日期键）。
 */
export function shanghaiFiveDayWindowUtc(now: Date = new Date()): {
  keys: string[];
  startUtc: Date;
  endUtc: Date;
} {
  const shiftedNow = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const todayMidnightShanghaiAsUtcMs = Date.UTC(
    shiftedNow.getUTCFullYear(),
    shiftedNow.getUTCMonth(),
    shiftedNow.getUTCDate(),
    0,
    0,
    0,
    0,
  );
  const firstDayMidnightShanghaiAsUtcMs =
    todayMidnightShanghaiAsUtcMs - (DASHBOARD_TREND_DAYS - 1) * DAY_MS;

  const keys: string[] = [];
  for (let i = 0; i < DASHBOARD_TREND_DAYS; i++) {
    const cur = new Date(firstDayMidnightShanghaiAsUtcMs + i * DAY_MS);
    const y = cur.getUTCFullYear();
    const m = String(cur.getUTCMonth() + 1).padStart(2, '0');
    const day = String(cur.getUTCDate()).padStart(2, '0');
    keys.push(`${y}-${m}-${day}`);
  }

  const startUtc = new Date(firstDayMidnightShanghaiAsUtcMs - SHANGHAI_OFFSET_MS);
  const endUtc = new Date(todayMidnightShanghaiAsUtcMs + DAY_MS - 1 - SHANGHAI_OFFSET_MS);

  return { keys, startUtc, endUtc };
}

/**
 * 计算 now 所在上海自然月的首尾 UTC 区间 `[startUtc, endUtc)` 及 `YYYY-MM` 月份标识。
 */
export function shanghaiCurrentMonthWindowUtc(now: Date = new Date()): {
  monthKey: string;
  startUtc: Date;
  endUtc: Date;
} {
  const shiftedNow = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const year = shiftedNow.getUTCFullYear();
  const monthIdx = shiftedNow.getUTCMonth();
  const monthKey = `${year}-${String(monthIdx + 1).padStart(2, '0')}`;

  const monthStartShanghaiAsUtcMs = Date.UTC(year, monthIdx, 1, 0, 0, 0, 0);
  const nextMonthStartShanghaiAsUtcMs = Date.UTC(year, monthIdx + 1, 1, 0, 0, 0, 0);

  return {
    monthKey,
    startUtc: new Date(monthStartShanghaiAsUtcMs - SHANGHAI_OFFSET_MS),
    endUtc: new Date(nextMonthStartShanghaiAsUtcMs - SHANGHAI_OFFSET_MS),
  };
}

/**
 * 按上海自然日聚合近 5 日的 AI 写作（AI_TASK）与爆文复刻（REWRITE_SINGLE / REWRITE_BATCH）文章数。
 * 手动添加（MANUAL）及窗口外文章不计入趋势，严格输出 5 天。
 */
export function aggregateCreationTrend5Days(
  articles: ReadonlyArray<{ source: string; createdAt: Date | string }>,
  now: Date = new Date(),
): DashboardTrendDay[] {
  const { keys } = shanghaiFiveDayWindowUtc(now);
  const buckets = new Map<string, { writing: number; rewrite: number }>();
  for (const key of keys) {
    buckets.set(key, { writing: 0, rewrite: 0 });
  }

  for (const row of articles) {
    const dateKey = toShanghaiDateKey(row.createdAt);
    const bucket = buckets.get(dateKey);
    if (!bucket) continue;
    if (row.source === 'AI_TASK') {
      bucket.writing += 1;
    } else if (row.source === 'REWRITE_SINGLE' || row.source === 'REWRITE_BATCH') {
      bucket.rewrite += 1;
    }
  }

  return keys.map((date) => {
    const bucket = buckets.get(date) ?? { writing: 0, rewrite: 0 };
    return {
      date,
      label: date.slice(5),
      writingCount: bucket.writing,
      rewriteCount: bucket.rewrite,
      totalCount: bucket.writing + bucket.rewrite,
    };
  });
}

/**
 * 汇总当月 PointLog，保证首页「点数卡·本月消耗」与 `/me/points` 明细完全一致。
 */
export function summarizeMonthPoints(
  logs: ReadonlyArray<{
    delta: number;
    listPrice: number;
    status: string;
    action: string;
  }>,
): {
  actualConsumed: number;
  listPriceConsumed: number;
  recharged: number;
} {
  let actualConsumed = 0;
  let listPriceConsumed = 0;
  let recharged = 0;

  for (const row of logs) {
    if (row.status !== 'SETTLED') continue;
    if (row.delta > 0) {
      recharged += row.delta;
      continue;
    }
    if (row.delta < 0) {
      actualConsumed += -row.delta;
    }
    if (row.action !== 'admin_topup' && row.delta <= 0) {
      const price = row.listPrice > 0 ? row.listPrice : -row.delta;
      if (price > 0) {
        listPriceConsumed += price;
      }
    }
  }

  return { actualConsumed, listPriceConsumed, recharged };
}

function moneyStringToCents(raw: string): bigint {
  const formatted = formatMoney(raw);
  const negative = formatted.startsWith('-');
  const unsigned = negative ? formatted.slice(1) : formatted;
  const [whole = '0', frac = '00'] = unsigned.split('.');
  const cents = BigInt(whole) * 100n + BigInt(frac);
  return negative ? -cents : cents;
}

function centsToMoneyString(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const frac = String(abs % 100n).padStart(2, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${frac}`;
}

/**
 * 汇总当月 MoneyLog，使用整数分运算避免浮点误差，与 `/me/money` 明细完全一致。
 */
export function summarizeMonthMoney(logs: ReadonlyArray<{ amount: string }>): {
  consumed: string;
  recharged: string;
} {
  let consumedCents = 0n;
  let rechargedCents = 0n;

  for (const row of logs) {
    const cents = moneyStringToCents(row.amount);
    if (cents < 0n) {
      consumedCents += -cents;
    } else if (cents > 0n) {
      rechargedCents += cents;
    }
  }

  return {
    consumed: centsToMoneyString(consumedCents),
    recharged: centsToMoneyString(rechargedCents),
  };
}

/**
 * 根据功能开关过滤首页可见入口卡片（例如关闭 FEATURE_AI_IMAGE 时隐藏 AI 生图入口）。
 */
export function visibleDashboardEntryCards(options?: {
  aiImageEnabled?: boolean;
}): DashboardEntryCardDef[] {
  return DASHBOARD_ENTRY_CARDS.filter((card) => {
    if (card.featureFlag === 'aiImage' && options?.aiImageEnabled === false) {
      return false;
    }
    return true;
  });
}
