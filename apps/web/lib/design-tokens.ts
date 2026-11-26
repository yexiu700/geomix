import type { CitationSourceKind, ItemStatusName, TaskStatusName } from '@geomix/shared';
import { theme } from 'antd';

export const GM = {
  bg: {
    base: '#090B0A',
    surface: '#111513',
    elevated: '#181D1B',
    overlay: '#202623',
    hover: 'rgba(255,255,255,0.035)',
    selected: 'rgba(255,255,255,0.07)',
    mask: 'rgba(4,6,5,0.72)',
  },
  surface: {
    s0: '#090B0A',
    s1: '#111513',
    s2: '#181D1B',
    s3: '#202623',
  },
  border: {
    outer: 'rgba(255, 255, 255, 0.065)',
    inner: 'rgba(255, 255, 255, 0.06)',
    specularTop: 'inset 0 1px 0 rgba(255, 255, 255, 0.045)',
  },
  selected: {
    bg: 'rgba(255, 255, 255, 0.07)',
    fg: '#EEF2F0',
  },
  container: {
    wide: 1360,
    form: 1040,
    prose: 720,
  },
  line: {
    l1: 'rgba(255,255,255,0.06)',
    l2: 'rgba(255,255,255,0.10)',
    strong: 'rgba(255,255,255,0.16)',
  },
  fg: {
    f1: '#EEF2F0',
    f2: '#ADB6B2',
    f3: '#838D89',
    f4: '#5E6864',
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
    ECOMMERCE: '#B692F6',
    OTHER: '#7C8683',
  } satisfies Record<CitationSourceKind, string>,
  taskStatus: {
    QUEUED: '#9AA6B2',
    RUNNING: '#6FA8FF',
    PAUSED: '#F2B84B',
    COMPLETED: '#3DE0C8',
    PARTIAL: '#E9C46A',
    FAILED: '#F0605D',
    CANCELLED: '#838D89',
  } satisfies Record<TaskStatusName, string>,
  itemStatus: {
    PENDING: '#9AA6B2',
    RUNNING: '#6FA8FF',
    SUCCESS: '#3DE0C8',
    FAILED: '#F0605D',
    SKIPPED: '#838D89',
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
    axis: '#838D89',
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
    colorBgBase: '#090B0A',
    colorBgLayout: '#090B0A',
    colorBgContainer: '#111513',
    colorBgElevated: '#181D1B',
    colorBgMask: 'rgba(4,6,5,0.72)',
    colorBorder: 'rgba(255,255,255,0.10)',
    colorBorderSecondary: 'rgba(255,255,255,0.06)',
    colorSplit: 'rgba(255,255,255,0.06)',
    colorText: '#EEF2F0',
    colorTextSecondary: '#ADB6B2',
    colorTextTertiary: '#838D89',
    colorTextQuaternary: '#5E6864',
    fontFamily: 'var(--gm-font-sans)',
    fontFamilyCode: 'var(--gm-font-mono)',
    fontSize: 13,
    fontSizeSM: 12,
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
      colorPrimary: '#C5F04A',
      colorPrimaryHover: '#D4F772',
      colorPrimaryActive: '#A9D62F',
      primaryColor: '#0A0C0B',
      primaryShadow: 'none',
      defaultShadow: 'none',
      dangerShadow: 'none',
      defaultBg: '#181D1B',
      defaultBorderColor: 'rgba(255,255,255,0.10)',
      fontWeight: 500,
    },
    Checkbox: { colorWhite: '#0A0C0B' },
    Radio: { buttonSolidCheckedColor: '#0A0C0B' },
    Layout: {
      bodyBg: '#090B0A',
      headerBg: '#090B0A',
      siderBg: '#090B0A',
      headerHeight: 48,
      headerPadding: '0 16px',
    },
    Menu: {
      darkItemBg: '#090B0A',
      darkSubMenuItemBg: '#090B0A',
      darkItemColor: '#ADB6B2',
      darkItemHoverColor: '#EEF2F0',
      darkItemHoverBg: 'rgba(255,255,255,0.035)',
      darkItemSelectedBg: 'rgba(255, 255, 255, 0.07)',
      darkItemSelectedColor: '#EEF2F0',
      darkGroupTitleColor: '#838D89',
      itemHeight: 32,
      itemBorderRadius: 6,
      itemMarginInline: 8,
      iconSize: 14,
    },
    Segmented: {
      itemSelectedBg: 'rgba(255, 255, 255, 0.08)',
      itemSelectedColor: '#EEF2F0',
    },
    Table: {
      headerBg: '#181D1B',
      headerColor: '#838D89',
      headerSplitColor: 'transparent',
      borderColor: 'rgba(255,255,255,0.06)',
      rowHoverBg: 'rgba(255,255,255,0.035)',
      rowSelectedBg: 'rgba(255, 255, 255, 0.07)',
      rowSelectedHoverBg: 'rgba(255, 255, 255, 0.10)',
      cellPaddingBlock: 12,
      cellPaddingInline: 12,
      cellFontSize: 13,
    },
    Tabs: {
      inkBarColor: '#C5F04A',
      itemSelectedColor: '#EEF2F0',
      itemColor: '#838D89',
      itemHoverColor: '#ADB6B2',
    },
    Tooltip: {
      colorBgSpotlight: '#1D2220',
      colorTextLightSolid: '#E8ECEA',
    },
    Modal: {
      contentBg: '#181D1B',
      headerBg: '#181D1B',
      footerBg: '#181D1B',
    },
    Drawer: { colorBgElevated: '#111513' },
    Tag: {
      defaultBg: 'transparent',
      defaultColor: '#ADB6B2',
    },
    Select: {
      optionSelectedBg: 'rgba(255, 255, 255, 0.08)',
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
