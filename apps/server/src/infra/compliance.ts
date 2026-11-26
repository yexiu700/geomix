import { createHash } from 'node:crypto';
import {
  API_ERROR,
  CN_SENSITIVE_TERMS,
  formatComplianceBlockMessage,
  scanDualTrackCompliance,
  type DualTrackComplianceOptions,
  type GeoComplianceFlag,
  type GeoMarket,
} from '@geomix/shared';
import { ApiError } from '../common/api-error';

export type ComplianceHit = {
  category: 'industry' | 'sensitive' | 'extreme' | 'custom' | 'ftc';
  label: string;
};

export type ComplianceReport = {
  market: GeoMarket;
  blocked: boolean;
  text: string;
  hits: ComplianceHit[];
  flags: ComplianceHit[];
  geoFlags: GeoComplianceFlag[];
};

export type AuditPayload = {
  action: string;
  labels: string[];
  sha256: string;
  market?: GeoMarket;
};

export type AuditWriter = {
  write(entry: {
    tenantId?: string;
    userId?: string;
    action: string;
    payload: AuditPayload;
  }): Promise<void>;
};

const SENSITIVE_SET = new Set<string>(CN_SENSITIVE_TERMS);

export function scanCompliance(
  input: string,
  options?: DualTrackComplianceOptions,
): ComplianceReport {
  const report = scanDualTrackCompliance(input, options);
  if (report.blocked) {
    const hits: ComplianceHit[] = report.blockedTerms.map((term) => ({
      category: term === 'invalid' || SENSITIVE_SET.has(term) ? 'sensitive' : 'industry',
      label: term,
    }));
    return {
      market: report.market,
      blocked: true,
      text: '',
      hits,
      flags: [],
      geoFlags: report.flags,
    };
  }

  const hits: ComplianceHit[] = [];
  const flags: ComplianceHit[] = [];
  for (const flag of report.flags) {
    if (flag.code === 'AD_LAW_SUPERLATIVE') {
      hits.push({ category: 'extreme', label: flag.term });
    } else if (flag.code === 'AD_LAW_FLAG') {
      flags.push({ category: 'extreme', label: flag.term });
    } else if (flag.code === 'CUSTOM_FORBIDDEN') {
      hits.push({ category: 'custom', label: flag.term });
    } else if (flag.code === 'FTC_NOTICE') {
      flags.push({ category: 'ftc', label: flag.term });
    }
  }

  return {
    market: report.market,
    blocked: false,
    text: report.text,
    hits,
    flags,
    geoFlags: report.flags,
  };
}

export class ComplianceService {
  constructor(private readonly audit?: AuditWriter) {}

  scan(text: string, options?: DualTrackComplianceOptions): ComplianceReport {
    return scanCompliance(text, options);
  }

  async assertAllowed(input: {
    text: string;
    action: string;
    market?: GeoMarket;
    customForbiddenWords?: readonly string[];
    tenantId?: string;
    userId?: string;
  }): Promise<ComplianceReport> {
    const report = scanCompliance(input.text, {
      market: input.market,
      customForbiddenWords: input.customForbiddenWords,
    });
    if (!report.blocked) return report;
    const payload: AuditPayload = {
      action: input.action,
      labels: report.hits.map((hit) => hit.label),
      sha256: createHash('sha256').update(input.text).digest('hex'),
      ...(input.market ? { market: input.market } : {}),
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
    throw new ApiError(
      403,
      API_ERROR.FORBIDDEN_INDUSTRY,
      formatComplianceBlockMessage(
        report.hits.map((hit) => hit.label),
        { market: input.market, context: 'input' },
      ),
    );
  }
}
