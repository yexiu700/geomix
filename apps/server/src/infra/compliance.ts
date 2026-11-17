import { createHash } from 'node:crypto';
import { API_ERROR } from '@geomix/shared';
import { ApiError } from '../common/api-error';

/**
 * 自写的保守词表。路线里提到的原名单不在这个仓库，这里不抄，也不写具体品牌。
 * 未确认的完整极限词表先只覆盖明确的广告极限说法；「最近」「最后」不会被当成极限词。
 */

const INDUSTRY = [
  '赌博',
  '博彩',
  '六合彩',
  '私彩',
  '色情',
  '淫秽',
  '卖淫',
  '毒品',
  '冰毒',
  '大麻',
  '枪支',
  '弹药',
  '炸药',
  '传销',
  '假币',
  '假证',
  '代开发票',
  '迷药',
  '民营医院',
  '男科',
  '妇科',
  '不孕不育',
  '整形医美',
  '包治百病',
  '祖传秘方',
  '网贷',
  '高利贷',
  '校园贷',
  '现金贷',
  '套路贷',
  '网贷催收',
  '非法催收',
  '虚拟币',
  '炒币',
  '外汇配资',
  '场外配资',
  '非法集资',
  '电子烟',
  '烟草代购',
] as const;

const SENSITIVE = ['窃听', '偷拍', '勒索软件', '木马程序'] as const;

const REPLACEMENTS: Array<{ pattern: RegExp; to: string; label: string }> = [
  { pattern: /100\s*%|百分之百/g, to: '较高比例', label: '100%' },
  { pattern: /国家级/g, to: '行业内', label: '国家级' },
  { pattern: /世界级/g, to: '较高水平', label: '世界级' },
  { pattern: /独一无二/g, to: '有特点', label: '独一无二' },
  { pattern: /顶级/g, to: '高水平', label: '顶级' },
  { pattern: /极致/g, to: '细致', label: '极致' },
  { pattern: /最好|最强|最低价|最高级|最先进|最优/g, to: '较好', label: '最' },
  { pattern: /全网第一|行业第一|销量第一|排名第一|第一品牌/g, to: '较为靠前', label: '第一' },
];

const FLAGS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /绝对/, label: '绝对' },
  { pattern: /永久/, label: '永久' },
];

export type ComplianceHit = { category: 'industry' | 'sensitive' | 'extreme'; label: string };

export type ComplianceReport = {
  blocked: boolean;
  text: string;
  hits: ComplianceHit[];
  flags: ComplianceHit[];
};

export type AuditPayload = {
  action: string;
  labels: string[];
  sha256: string;
};

export type AuditWriter = {
  write(entry: {
    tenantId?: string;
    userId?: string;
    action: string;
    payload: AuditPayload;
  }): Promise<void>;
};

export function scanCompliance(input: string): ComplianceReport {
  if (typeof input !== 'string') {
    return {
      blocked: true,
      text: '',
      hits: [{ category: 'sensitive', label: 'invalid' }],
      flags: [],
    };
  }
  const hits: ComplianceHit[] = [];
  for (const label of INDUSTRY) {
    if (input.includes(label)) hits.push({ category: 'industry', label });
  }
  for (const label of SENSITIVE) {
    if (input.includes(label)) hits.push({ category: 'sensitive', label });
  }
  if (hits.length > 0) {
    return { blocked: true, text: '', hits, flags: [] };
  }
  let text = input;
  const replaced: ComplianceHit[] = [];
  for (const rule of REPLACEMENTS) {
    text = text.replace(rule.pattern, () => {
      replaced.push({ category: 'extreme', label: rule.label });
      return rule.to;
    });
  }
  const flags: ComplianceHit[] = [];
  for (const rule of FLAGS) {
    if (rule.pattern.test(text)) flags.push({ category: 'extreme', label: rule.label });
  }
  return { blocked: false, text, hits: replaced, flags };
}

export class ComplianceService {
  constructor(private readonly audit?: AuditWriter) {}

  scan(text: string): ComplianceReport {
    return scanCompliance(text);
  }

  async assertAllowed(input: {
    text: string;
    action: string;
    tenantId?: string;
    userId?: string;
  }): Promise<ComplianceReport> {
    const report = scanCompliance(input.text);
    if (!report.blocked) return report;
    const payload = {
      action: input.action,
      labels: report.hits.map((hit) => hit.label),
      sha256: createHash('sha256').update(input.text).digest('hex'),
    };
    try {
      await this.audit?.write({
        tenantId: input.tenantId,
        userId: input.userId,
        action: 'forbidden_blocked',
        payload,
      });
    } catch {
      // 审计写失败仍然拦截，避免因为日志故障放行。
    }
    throw new ApiError(403, API_ERROR.FORBIDDEN_INDUSTRY, '包含禁做行业或敏感内容');
  }
}
