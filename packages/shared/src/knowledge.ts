import { z } from 'zod';
import { COPY_TYPES, CREATIVE_DIRECTIONS } from './catalog';

export const KB_MODES = ['DETAIL', 'SUMMARY'] as const;
export type KbModeName = (typeof KB_MODES)[number];

export const KB_MODE_LABELS: Record<KbModeName, string> = {
  DETAIL: '细分模式',
  SUMMARY: '汇总模式',
};

export const KB_INDEX_STATUSES = ['NONE', 'INDEXING', 'READY', 'FAILED'] as const;
export type KbIndexStatusName = (typeof KB_INDEX_STATUSES)[number];

export const KB_INDEX_STATUS_LABELS: Record<KbIndexStatusName, string> = {
  NONE: '免索引',
  INDEXING: '索引中',
  READY: '可用',
  FAILED: '索引失败',
};

export const KB_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const KB_NAME_MAX = 60 as const;
export const KB_COMPANY_MAX = 100 as const;
export const KB_BRAND_SHORT_MAX = 60 as const;
export const KB_DETAIL_FIELD_MAX = 1000 as const;
export const KB_SUMMARY_MAX = 20_000 as const;
export const KB_FULL_INJECT_MAX = 6000 as const;
export const KB_CHUNK_SIZE = 600 as const;
export const KB_CHUNK_OVERLAP = 80 as const;
export const KB_TOP_K_CHUNKS = 5 as const;

export const KB_AGREEMENT_KIND = 'kb_truthfulness' as const;
export const KB_AGREEMENT_VERSION = 'v1.0' as const;
export const KB_UNSIGNED_ERROR_MSG = '请先阅读并签署必读承诺协议';

export const KB_WARNING_BANNER_TEXT =
  '重要提醒：请确保录入的企业资料、资质说明与业务案例均真实、客观、可核验，严禁编造虚假数据、虚构合作客户或违规对比贬低同业。提交前须先阅读并签署承诺协议。';

export const KB_AGREEMENT_CHECKBOX_LABEL = '我已仔细阅读并同意以上所有条款';
export const KB_AGREEMENT_CONFIRM_BUTTON_LABEL = '确认已阅读并承诺信息是真实数据';

/**
 * GeoMix 自写《企业知识库信息真实性与合规承诺函》（严禁引用任何外部站点原文）。
 */
export const KB_AGREEMENT_TITLE = 'GeoMix 企业知识库信息真实性与合规承诺协议';

export const KB_AGREEMENT_PARAGRAPHS: readonly string[] = [
  '一、总则与适用范围：本承诺协议适用于商户在 GeoMix 平台创建、编辑及维护「企业知识库」过程中录入的全部文字资料，包括但不限于企业名称、品牌简称、主营产品与服务、技术特点、发展历程、痛点分析、资质荣誉及客户服务记录。',
  '二、信息真实性义务：商户承诺所填写的企业主体信息、产品参数、工艺标准、交付能力及服务范围均源于本企业真实经营情况，不存在虚构事实、隐瞒关键限制条件或伪造检验检测结论的行为。',
  '三、资质与背书核验：凡在「信任背书」等栏目提及专利、软件著作权、管理体系认证、行业奖项或第三方合作关系的，商户应持有合法有效且在有效期内的证明文件备查，不得录入已过期、被撤销或不属于本企业的资质。',
  '四、案例与数据审慎原则：凡在「客户案例」或汇总资料中引用项目成效、效率变化或客户评价的，须具备真实履约依据并已取得必要的商业披露许可；未获客户书面同意公开名称的，应采用行业泛称脱敏描述，严禁虚构标杆客户或编造百分比成效。',
  '五、广告合规与公平竞争：商户应严格遵守《中华人民共和国民法典》《中华人民共和国广告法》《中华人民共和国反不正当竞争法》及《计算机软件保护条例》等相关法律法规，不得录入「国家级」「最高级」「最佳」「第一」等绝对化用语，不得捏造、散布损害其他经营者商业信誉或商品声誉的内容。',
  '六、知识产权合法来源：商户保证所录入文本不侵犯任何第三方的著作权、商标权、商业秘密或其他合法权益，不直接照搬他人受保护的宣传册、白皮书或网站专有文案。',
  '七、AI 辅助生成使用知悉：平台将依据商户录入的知识库资料进行结构化整理或智能内容检索辅助生成。若底层录入资料失实，由此引发的生成内容偏差、行政处罚、民事索赔或平台投诉，均由录入商户独立承担全部法律责任。',
  '八、违约处置与留痕存证：平台在签署时自动记录操作账号、所属租户、协议版本号、签署时间戳及网络来源地址。一经发现虚假或违法违规资料，平台有权采取拦截保存、下架关联文章、暂停任务直至封禁账号等处置措施。',
];

export const KB_DETAIL_FIELD_KEYS = [
  'productService',
  'productFeature',
  'brandStory',
  'painPoint',
  'trust',
  'cases',
  'other',
] as const;

export type KbDetailFieldKey = (typeof KB_DETAIL_FIELD_KEYS)[number];

export type KbDetailFields = Record<KbDetailFieldKey, string>;

export type KbFieldHelpDoc = {
  content: string;
  explanation: string;
  example: string;
};

export type KbDetailFieldMeta = {
  key: KbDetailFieldKey;
  label: string;
  placeholder: string;
  help?: KbFieldHelpDoc;
};

/**
 * 仅产品服务、产品特点、用户痛点、信任背书、客户案例 5 个字段带「查看说明」（V01 #36-#37）。
 * 所有说明与实例均为 GeoMix 自写中性示例。
 */
export const KB_DETAIL_FIELDS_META: readonly KbDetailFieldMeta[] = [
  {
    key: 'productService',
    label: '产品服务',
    placeholder: '产品服务，1000 字以内',
    help: {
      content: '填写企业主营产品线、核心服务项目、交付形态与适用行业范围。',
      explanation:
        '建议按「产品/服务名称 + 适用对象 + 交付范围」组织，语言平实具体，便于写作时准确匹配咨询场景。',
      example:
        '主营中厚板光纤激光切割设备、管板一体切割机及自动化上下料单元，面向工程机械、钣金加工与农机装备制造企业提供整机交付、驻场安装调试与操作培训服务。',
    },
  },
  {
    key: 'productFeature',
    label: '产品特点',
    placeholder: '产品特点，1000 字以内',
    help: {
      content: '填写产品在结构设计、工艺稳定性、运维便利性或服务响应上的客观特点。',
      explanation:
        '请提供可验证的技术规格或客观配置特征，避免使用「行业第一」「绝对领先」等绝对化表述。',
      example:
        '床身采用分段焊接退火去应力工艺，配备双驱龙门结构与自动调焦切割头；控制系统内置常见板材工艺参数库，支持套料排版导入与远程故障诊断。',
    },
  },
  {
    key: 'brandStory',
    label: '品牌故事',
    placeholder: '品牌故事，1000 字以内',
  },
  {
    key: 'painPoint',
    label: '用户痛点',
    placeholder: '用户痛点，1000 字以内',
    help: {
      content: '填写目标客户在选型、采购、日常生产或售后服务中常遇到的实际难题。',
      explanation:
        '聚焦真实业务困扰（如换型耗时、板材损耗、售后响应慢等），不刻意渲染焦虑，便于文章先共情再给出解决思路。',
      example:
        '多品种小批量钣金加工订单切换频繁，传统人工调参耗时长、厚板穿孔挂渣率偏高，且旺季设备停机等待配件容易影响交期。',
    },
  },
  {
    key: 'trust',
    label: '信任背书',
    placeholder: '信任背书，1000 字以内',
    help: {
      content: '填写企业真实持有的认证资质、研发投入、生产基地规模及服务网点保障。',
      explanation: '仅填写在有效期内且可出示证明的客观资质与硬件条件，未取得的资质请勿预填。',
      example:
        '拥有标准化装配车间 1.2 万平方米，通过 ISO9001 质量管理体系认证，取得激光加工夹具相关实用新型专利 8 项，在华东、华南设有备件仓库与驻点售后工程师团队。',
    },
  },
  {
    key: 'cases',
    label: '客户案例',
    placeholder: '客户案例，1000 字以内',
    help: {
      content: '填写已落地交付的代表性项目背景、配置方案与实际运行改善情况。',
      explanation:
        '若未获客户书面授权公开企业全称，请使用「某华东农机零部件制造企业」等脱敏表述，数据须与验收记录一致。',
      example:
        '为华东某专用车厢制造企业配置 12kW 大幅面激光切割机及单塔料库，替代原有等离子下料工序，碳钢中厚板切口二次打磨工时明显减少，白夜班连续排产稳定运行。',
    },
  },
  {
    key: 'other',
    label: '其他信息',
    placeholder: '其他信息，1000 字以内',
  },
];

export function emptyKbDetailFields(): KbDetailFields {
  return {
    productService: '',
    productFeature: '',
    brandStory: '',
    painPoint: '',
    trust: '',
    cases: '',
    other: '',
  };
}

export type AgreementStatusView = {
  kind: string;
  version: string;
  signed: boolean;
  signatureId: string | null;
  signedAt: string | null;
};

export type KnowledgeBaseRecord = {
  id: string;
  name: string;
  mode: KbModeName;
  companyName: string | null;
  brandShort: string | null;
  directions: string[];
  copyTypes: string[];
  fields: KbDetailFields | null;
  summaryText: string | null;
  indexStatus: KbIndexStatusName;
  chunkCount: number;
  signatureId: string;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeBaseListResponse = {
  items: KnowledgeBaseRecord[];
  total: number;
  page: number;
  pageSize: number;
  agreement: AgreementStatusView;
};

export type KnowledgeBaseListQuery = {
  page: number;
  pageSize: number;
  q?: string;
  mode?: KbModeName;
};

export const agreementSignSchema = z.object({
  kind: z.literal(KB_AGREEMENT_KIND).default(KB_AGREEMENT_KIND),
  version: z.literal(KB_AGREEMENT_VERSION).default(KB_AGREEMENT_VERSION),
});

export type AgreementSignInput = z.infer<typeof agreementSignSchema>;

const allowedDirections = new Set<string>(CREATIVE_DIRECTIONS);
const allowedCopyTypes = new Set<string>(COPY_TYPES);

const detailFieldsSchema = z.object({
  productService: z.string().max(KB_DETAIL_FIELD_MAX, '产品服务不能超过 1000 字').default(''),
  productFeature: z.string().max(KB_DETAIL_FIELD_MAX, '产品特点不能超过 1000 字').default(''),
  brandStory: z.string().max(KB_DETAIL_FIELD_MAX, '品牌故事不能超过 1000 字').default(''),
  painPoint: z.string().max(KB_DETAIL_FIELD_MAX, '用户痛点不能超过 1000 字').default(''),
  trust: z.string().max(KB_DETAIL_FIELD_MAX, '信任背书不能超过 1000 字').default(''),
  cases: z.string().max(KB_DETAIL_FIELD_MAX, '客户案例不能超过 1000 字').default(''),
  other: z.string().max(KB_DETAIL_FIELD_MAX, '其他信息不能超过 1000 字').default(''),
});

export const knowledgeDetailWriteSchema = z.object({
  name: z
    .string({ required_error: '请输入知识库名称' })
    .transform((s) => s.trim())
    .refine((s) => s.length > 0, '请输入知识库名称')
    .refine((s) => Array.from(s).length <= KB_NAME_MAX, `知识库名称不超过 ${KB_NAME_MAX} 字`),
  mode: z.literal('DETAIL'),
  companyName: z
    .string({ required_error: '请输入公司名称' })
    .transform((s) => s.trim())
    .refine((s) => s.length > 0, '请输入公司名称')
    .refine((s) => Array.from(s).length <= KB_COMPANY_MAX, `公司名称不超过 ${KB_COMPANY_MAX} 字`),
  brandShort: z
    .string({ required_error: '请输入品牌简称' })
    .transform((s) => s.trim())
    .refine((s) => s.length > 0, '请输入品牌简称')
    .refine(
      (s) => Array.from(s).length <= KB_BRAND_SHORT_MAX,
      `品牌简称不超过 ${KB_BRAND_SHORT_MAX} 字`,
    ),
  directions: z
    .array(z.string())
    .min(1, '请至少选择 1 个创作方向')
    .max(CREATIVE_DIRECTIONS.length)
    .refine((items) => items.every((d) => allowedDirections.has(d)), '包含无效的创作方向'),
  copyTypes: z
    .array(z.string())
    .min(1, '请至少选择 1 个文案类型')
    .max(COPY_TYPES.length)
    .refine((items) => items.every((c) => allowedCopyTypes.has(c)), '包含无效的文案类型'),
  fields: detailFieldsSchema.default(emptyKbDetailFields()),
});

export const knowledgeSummaryWriteSchema = z.object({
  name: z
    .string({ required_error: '请输入知识库名称' })
    .transform((s) => s.trim())
    .refine((s) => s.length > 0, '请输入知识库名称')
    .refine((s) => Array.from(s).length <= KB_NAME_MAX, `知识库名称不超过 ${KB_NAME_MAX} 字`),
  mode: z.literal('SUMMARY'),
  companyName: z
    .string()
    .transform((s) => s.trim())
    .refine(
      (s) => Array.from(s).length <= KB_COMPANY_MAX,
      `公司/品牌名称不超过 ${KB_COMPANY_MAX} 字`,
    )
    .optional()
    .nullable(),
  summaryText: z
    .string({ required_error: '请输入汇总信息' })
    .transform((s) => s.trim())
    .refine((s) => s.length > 0, '请输入汇总信息')
    .refine((s) => Array.from(s).length <= KB_SUMMARY_MAX, `汇总信息不能超过 ${KB_SUMMARY_MAX} 字`),
});

export const knowledgeWriteSchema = z.discriminatedUnion('mode', [
  knowledgeDetailWriteSchema,
  knowledgeSummaryWriteSchema,
]);

export type KnowledgeWriteInput = z.infer<typeof knowledgeWriteSchema>;

export const knowledgeBulkSchema = z.object({
  ids: z.array(z.string().regex(KB_ID_PATTERN, '编号不合法')).min(1, '请至少选择一条记录').max(100),
});

export type KnowledgeBulkInput = z.infer<typeof knowledgeBulkSchema>;

/**
 * 判断汇总文本是否需要进入 kb-index 切片向量化队列（> 6000 字）。
 */
export function requiresKbVectorIndex(mode: KbModeName, summaryText?: string | null): boolean {
  if (mode !== 'SUMMARY' || !summaryText) return false;
  return Array.from(summaryText.trim()).length > KB_FULL_INJECT_MAX;
}

/**
 * 按段落感知与固定窗口重叠切分汇总长文本（默认每块 600 字，重叠 80 字）。
 */
export function chunkKnowledgeText(
  rawText: string,
  chunkSize: number = KB_CHUNK_SIZE,
  overlap: number = KB_CHUNK_OVERLAP,
): string[] {
  const normalized = rawText.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  const chars = Array.from(normalized);
  if (chars.length <= chunkSize) {
    return [normalized];
  }

  const safeChunk = Math.max(100, chunkSize);
  const safeOverlap = Math.max(0, Math.min(overlap, Math.floor(safeChunk / 2)));
  const step = safeChunk - safeOverlap;

  const chunks: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(start + safeChunk, chars.length);
    if (end < chars.length) {
      // 优先在窗口后半段的换行或句末标点处自然断开
      const minBreak = start + Math.floor(safeChunk * 0.65);
      for (let cursor = end; cursor > minBreak; cursor -= 1) {
        const ch = chars[cursor - 1];
        if (ch === '\n' || ch === '。' || ch === '！' || ch === '？' || ch === '；') {
          end = cursor;
          break;
        }
      }
    }
    const piece = chars.slice(start, end).join('').trim();
    if (piece.length > 0) {
      chunks.push(piece);
    }
    if (end >= chars.length) break;
    const nextStart = end - safeOverlap;
    start = nextStart > start ? nextStart : start + step;
  }
  return chunks;
}

/**
 * 组装细分模式「企业事实卡」（只放非空字段，供 F04a §3.2 写作注入复用）。
 */
export function formatKnowledgeFactCard(input: {
  companyName?: string | null;
  brandShort?: string | null;
  fields?: Partial<KbDetailFields> | null;
}): string {
  const lines: string[] = ['只能使用以下事实，不得编造参数、资质或案例：'];
  const header = [
    input.companyName?.trim(),
    input.brandShort?.trim() ? `（${input.brandShort.trim()}）` : '',
  ]
    .filter(Boolean)
    .join('');
  if (header) {
    lines.push(`企业主体：${header}`);
  }
  const f = input.fields ?? {};
  for (const meta of KB_DETAIL_FIELDS_META) {
    const val = f[meta.key]?.trim();
    if (val) {
      lines.push(`${meta.label}：${val}`);
    }
  }
  return lines.join('\n');
}

export function isAgreementScrolledToBottom(metrics: {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}): boolean {
  return metrics.scrollTop + metrics.clientHeight >= metrics.scrollHeight - 8;
}

export function parseKnowledgeListQuery(
  raw: Record<string, string | string[] | undefined>,
): KnowledgeBaseListQuery {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const pageRaw = Number.parseInt(first(raw.page) ?? '1', 10);
  const sizeRaw = Number.parseInt(first(raw.pageSize) ?? '20', 10);
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.min(10_000, pageRaw)) : 1;
  const pageSize = Number.isFinite(sizeRaw) ? Math.max(1, Math.min(100, sizeRaw)) : 20;
  const q = first(raw.q)?.trim() || undefined;
  const modeVal = first(raw.mode)?.trim();
  const mode = modeVal === 'DETAIL' || modeVal === 'SUMMARY' ? modeVal : undefined;
  return { page, pageSize, q, mode };
}

export function knowledgeExportTable(rows: readonly KnowledgeBaseRecord[]): {
  headers: string[];
  rows: string[][];
} {
  return {
    headers: ['名称', '类型', '公司名', '创建时间'],
    rows: rows.map((row) => [
      row.name,
      KB_MODE_LABELS[row.mode],
      row.companyName ?? '',
      row.createdAt.slice(0, 19).replace('T', ' '),
    ]),
  };
}
