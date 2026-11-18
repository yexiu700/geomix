import type { CitationSourceKind, ItemStatusName, TaskStatusName } from '@geomix/shared';
import { theme } from 'antd';

export const GM = {
  bg: {
    base: '#0A0C0B',
    surface: '#111413',
    elevated: '#171B1A',
    overlay: '#1D2220',
    hover: 'rgba(255,255,255,0.035)',
    selected: 'rgba(197,240,74,0.07)',
    mask: 'rgba(4,6,5,0.72)',
  },
  line: {
    l1: 'rgba(255,255,255,0.06)',
    l2: 'rgba(255,255,255,0.10)',
    strong: 'rgba(255,255,255,0.16)',
  },
  fg: {
    f1: '#E8ECEA',
    f2: '#A4ADAA',
    f3: '#6E7774',
    f4: '#464E4B',
  },
  phosphor: '#C5F04A',
  phosphorHover: '#D4F772',
  phosphorActive: '#A9D62F',
  onPhosphor: '#0A0C0B',
  sig: {
    cited: '#3DE0C8',
    mention: '#9AA6B2',
    competitor: '#FF7A59',
    absent: '#59625F',
  },
  sigSoft: {
    cited: 'rgba(61,224,200,0.14)',
    mention: 'rgba(154,166,178,0.14)',
    competitor: 'rgba(255,122,89,0.14)',
    absent: 'rgba(89,98,95,0.12)',
  },
  sentiment: {
    positive: '#3DE0C8',
    neutral: '#9AA6B2',
    mixed: '#F2B84B',
    negative: '#F0605D',
  },
  sourceKind: {
    OWNED: '#3DE0C8',
    COMPETITOR: '#FF7A59',
    SOCIAL: '#6FA8FF',
    AUTHORITY: '#E9C46A',
    OTHER: '#7C8683',
  } satisfies Record<CitationSourceKind, string>,
  taskStatus: {
    QUEUED: '#9AA6B2',
    RUNNING: '#6FA8FF',
    PAUSED: '#F2B84B',
    COMPLETED: '#3DE0C8',
    PARTIAL: '#E9C46A',
    FAILED: '#F0605D',
    CANCELLED: '#6E7774',
  } satisfies Record<TaskStatusName, string>,
  itemStatus: {
    PENDING: '#9AA6B2',
    RUNNING: '#6FA8FF',
    SUCCESS: '#3DE0C8',
    FAILED: '#F0605D',
    SKIPPED: '#6E7774',
  } satisfies Record<ItemStatusName, string>,
  status: {
    success: '#3DE0C8',
    info: '#6FA8FF',
    warning: '#F2B84B',
    danger: '#F0605D',
  },
  chart: {
    c1: '#8BD3FF',
    c2: '#F2B84B',
    c3: '#3DE0C8',
    grid: 'rgba(255,255,255,0.06)',
    axis: '#6E7774',
  },
} as const;

export const GM_ANTD_THEME = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: '#C5F04A',
    colorInfo: '#6FA8FF',
    colorSuccess: '#3DE0C8',
    colorWarning: '#F2B84B',
    colorError: '#F0605D',
    colorLink: '#6FA8FF',
    colorBgBase: '#0A0C0B',
    colorBgLayout: '#0A0C0B',
    colorBgContainer: '#111413',
    colorBgElevated: '#171B1A',
    colorBgMask: 'rgba(4,6,5,0.72)',
    colorBorder: 'rgba(255,255,255,0.10)',
    colorBorderSecondary: 'rgba(255,255,255,0.06)',
    colorSplit: 'rgba(255,255,255,0.06)',
    colorText: '#E8ECEA',
    colorTextSecondary: '#A4ADAA',
    colorTextTertiary: '#6E7774',
    colorTextQuaternary: '#464E4B',
    fontFamily: 'var(--gm-font-sans)',
    fontFamilyCode: 'var(--gm-font-mono)',
    fontSize: 13,
    borderRadius: 6,
    borderRadiusSM: 4,
    borderRadiusLG: 8,
    controlHeight: 32,
    controlHeightSM: 26,
    motionDurationFast: '0.12s',
    motionDurationMid: '0.18s',
    motionDurationSlow: '0.24s',
    motionEaseOut: 'cubic-bezier(0.16, 1, 0.3, 1)',
    boxShadow: '0 0 0 1px rgba(255,255,255,0.08), 0 12px 32px rgba(0,0,0,0.56)',
    boxShadowSecondary: '0 0 0 1px rgba(255,255,255,0.08), 0 12px 32px rgba(0,0,0,0.56)',
  },
  components: {
    Button: {
      primaryColor: '#0A0C0B',
      primaryShadow: 'none',
      defaultShadow: 'none',
      dangerShadow: 'none',
      defaultBg: '#171B1A',
      defaultBorderColor: 'rgba(255,255,255,0.10)',
      fontWeight: 500,
    },
    Checkbox: { colorWhite: '#0A0C0B' },
    Radio: { buttonSolidCheckedColor: '#0A0C0B' },
    Layout: {
      bodyBg: '#0A0C0B',
      headerBg: '#0A0C0B',
      siderBg: '#0A0C0B',
      headerHeight: 48,
      headerPadding: '0 16px',
    },
    Menu: {
      darkItemBg: '#0A0C0B',
      darkSubMenuItemBg: '#0A0C0B',
      darkItemColor: '#A4ADAA',
      darkItemHoverColor: '#E8ECEA',
      darkItemHoverBg: 'rgba(255,255,255,0.035)',
      darkItemSelectedBg: 'rgba(197,240,74,0.07)',
      darkItemSelectedColor: '#E8ECEA',
      darkGroupTitleColor: '#6E7774',
      itemHeight: 32,
      itemBorderRadius: 6,
      itemMarginInline: 8,
      iconSize: 14,
    },
    Table: {
      headerBg: '#171B1A',
      headerColor: '#6E7774',
      headerSplitColor: 'transparent',
      borderColor: 'rgba(255,255,255,0.06)',
      rowHoverBg: 'rgba(255,255,255,0.035)',
      rowSelectedBg: 'rgba(197,240,74,0.07)',
      rowSelectedHoverBg: 'rgba(197,240,74,0.10)',
      cellPaddingBlock: 12,
      cellPaddingInline: 12,
      cellFontSize: 13,
    },
    Tabs: {
      inkBarColor: '#C5F04A',
      itemSelectedColor: '#E8ECEA',
      itemColor: '#6E7774',
      itemHoverColor: '#A4ADAA',
    },
    Tooltip: {
      colorBgSpotlight: '#1D2220',
      colorTextLightSolid: '#E8ECEA',
    },
    Modal: {
      contentBg: '#171B1A',
      headerBg: '#171B1A',
      footerBg: '#171B1A',
    },
    Drawer: { colorBgElevated: '#111413' },
    Tag: {
      defaultBg: 'rgba(255,255,255,0.04)',
      defaultColor: '#A4ADAA',
    },
    Select: {
      optionSelectedBg: 'rgba(197,240,74,0.10)',
      optionActiveBg: 'rgba(255,255,255,0.05)',
    },
    Input: {
      activeShadow: '0 0 0 2px rgba(197,240,74,0.20)',
      hoverBorderColor: 'rgba(255,255,255,0.16)',
    },
    Pagination: { itemActiveBg: 'transparent' },
  },
} as const;

export function formatPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) {
    return '—';
  }
  return `${v.toFixed(1)}%`;
}

const compactFormatter = new Intl.NumberFormat('zh-CN', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) {
    return '—';
  }
  if (Math.abs(n) >= 10000) {
    return compactFormatter.format(n);
  }
  return String(n);
}

export function truncateMiddle(s: string, max = 56): string {
  if (s.length <= max) {
    return s;
  }
  if (max <= 21) {
    return s.slice(0, Math.max(0, max));
  }
  return `${s.slice(0, max - 21)}…${s.slice(-20)}`;
}
