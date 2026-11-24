'use client';

import {
  MARKETING_LEAD_MARKETS,
  MARKETING_LEAD_MARKET_LABELS,
  PUBLIC_PRICING_FALLBACK,
  createMarketingLeadSchema,
  type CreateMarketingLeadPayload,
  type MarketingLeadMarket,
  type MarketingLocale,
} from '@geomix/shared';
import Link from 'next/link';
import { useId, useRef, useState, type FormEvent } from 'react';
import { isMarketingApiError, submitMarketingLead } from '../../lib/marketing-api';
import type { DemoPrefill } from './demo-page-utils';

export interface DemoRequestFormProps {
  locale: MarketingLocale;
  initialPrefill: DemoPrefill;
}

type DemoFieldName =
  'name' | 'email' | 'companyBrand' | 'websiteUrl' | 'targetMarket' | 'monthlyGoal' | 'notes';

type FieldErrors = Partial<Record<DemoFieldName, string>>;

interface SubmitBannerState {
  tone: 'danger' | 'warning';
  message: string;
}

const CJK_CHAR_RE = /[\u3400-\u9fff]/;

function localizeZodFieldError(
  field: DemoFieldName,
  issueCode: string,
  issueMessage: string,
  locale: MarketingLocale,
): string {
  const isZh = locale === 'zh-CN';
  const msg = issueMessage.toLowerCase();

  switch (field) {
    case 'name':
      if (msg.includes('80')) {
        return isZh ? '联系人姓名不能超过 80 个字符。' : 'Name must be 80 characters or fewer.';
      }
      if (msg.includes('invalid')) {
        return isZh ? '联系人姓名包含无效控制字符。' : 'Name contains invalid characters.';
      }
      return isZh ? '请填写您的姓名。' : 'Please enter your name.';
    case 'email':
      if (msg.includes('160')) {
        return isZh ? '工作邮箱不能超过 160 个字符。' : 'Email must be 160 characters or fewer.';
      }
      return isZh ? '请输入有效的工作邮箱地址。' : 'Please enter a valid work email address.';
    case 'companyBrand':
      if (msg.includes('120')) {
        return isZh
          ? '公司或品牌名称不能超过 120 个字符。'
          : 'Company or brand name must be 120 characters or fewer.';
      }
      if (msg.includes('invalid')) {
        return isZh
          ? '公司或品牌名称包含无效控制字符。'
          : 'Company or brand name contains invalid characters.';
      }
      return isZh ? '请填写您的公司或品牌名称。' : 'Please enter your company or brand name.';
    case 'websiteUrl':
      if (msg.includes('500')) {
        return isZh
          ? '官网 URL 不能超过 500 个字符。'
          : 'Website URL must be 500 characters or fewer.';
      }
      return isZh
        ? '请输入有效的公网 http:// 或 https:// 品牌官网地址（不支持内网地址或 IP）。'
        : 'Please enter a valid public http:// or https:// website URL (no local or IP hosts).';
    case 'targetMarket':
      return isZh ? '请选择有效的目标市场。' : 'Please select a valid target market.';
    case 'monthlyGoal':
      if (msg.includes('160') || issueCode === 'too_big') {
        return isZh
          ? '月度目标说明不能超过 160 个字符。'
          : 'Monthly goal must be 160 characters or fewer.';
      }
      return isZh ? '月度目标包含无效控制字符。' : 'Monthly goal contains invalid characters.';
    case 'notes':
      if (msg.includes('2000') || issueCode === 'too_big') {
        return isZh ? '补充说明不能超过 2000 个字符。' : 'Notes must be 2000 characters or fewer.';
      }
      return isZh ? '补充说明包含无效控制字符。' : 'Notes contain invalid characters.';
  }
}

export function DemoRequestForm({ locale, initialPrefill }: DemoRequestFormProps) {
  const isZh = locale === 'zh-CN';
  const baseId = useId();
  const inFlightRef = useRef(false);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [companyBrand, setCompanyBrand] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [targetMarket, setTargetMarket] = useState<MarketingLeadMarket>(
    initialPrefill.targetMarket,
  );
  const [monthlyGoal, setMonthlyGoal] = useState(initialPrefill.monthlyGoal ?? '');
  const [estimatedPts, setEstimatedPts] = useState<number | undefined>(initialPrefill.estimatedPts);
  const [notes, setNotes] = useState('');
  const [honeypot, setHoneypot] = useState('');

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [banner, setBanner] = useState<SubmitBannerState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submittedSummary, setSubmittedSummary] = useState<{
    companyBrand: string;
    email: string;
  } | null>(null);

  const clearFieldError = (field: DemoFieldName) => {
    setFieldErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlightRef.current) return;

    const payload: CreateMarketingLeadPayload = {
      locale,
      name,
      email,
      companyBrand,
      websiteUrl: websiteUrl.trim() ? websiteUrl.trim() : undefined,
      targetMarket,
      monthlyGoal: monthlyGoal.trim() ? monthlyGoal.trim() : undefined,
      estimatedPts,
      notes: notes.trim() ? notes.trim() : undefined,
      sourcePage: isZh ? '/zh/demo' : '/demo',
      honeypot: honeypot ? honeypot.slice(0, 500) : undefined,
    };

    const parsed = createMarketingLeadSchema.safeParse(payload);
    if (!parsed.success) {
      const nextErrors: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (
          typeof key === 'string' &&
          !nextErrors[key as DemoFieldName] &&
          (key === 'name' ||
            key === 'email' ||
            key === 'companyBrand' ||
            key === 'websiteUrl' ||
            key === 'targetMarket' ||
            key === 'monthlyGoal' ||
            key === 'notes')
        ) {
          nextErrors[key] = localizeZodFieldError(key, issue.code, issue.message, locale);
        }
      }
      setFieldErrors(nextErrors);
      setBanner({
        tone: 'danger',
        message: isZh
          ? '请先修正标红字段后再提交申请。'
          : 'Please review the highlighted fields before submitting.',
      });
      return;
    }

    inFlightRef.current = true;
    setSubmitting(true);
    setFieldErrors({});
    setBanner(null);

    try {
      await submitMarketingLead(payload);
      setSubmittedSummary({
        companyBrand: parsed.data.companyBrand,
        email: parsed.data.email,
      });
    } catch (error) {
      if (isMarketingApiError(error)) {
        if (error.status === 429) {
          const retryMsg = error.retryAfterSeconds
            ? isZh
              ? `提交过于频繁，请约 ${error.retryAfterSeconds} 秒后再试。您填写的内容已保留。`
              : `Too many requests. Please retry in about ${error.retryAfterSeconds} seconds. Your entries have been preserved.`
            : isZh
              ? '提交过于频繁，请稍等几分钟后再试。您填写的内容已保留。'
              : 'Too many requests. Please wait a few minutes and try again. Your entries have been preserved.';
          setBanner({ tone: 'warning', message: retryMsg });
        } else if (error.status === 400) {
          const safeEnMessage =
            !isZh && error.message && !CJK_CHAR_RE.test(error.message) ? error.message : null;
          setBanner({
            tone: 'danger',
            message: isZh
              ? '提交信息未通过格式校验，请检查邮箱、品牌官网链接及字数限制后重试。'
              : (safeEnMessage ??
                'Some fields could not be validated. Please check your email and website URL and try again.'),
          });
        } else if (error.status === 0) {
          setBanner({
            tone: 'danger',
            message: isZh
              ? '网络连接异常，暂时无法送达申请。您的表单内容已保留，请稍后重试。'
              : 'Network error — we could not reach the server. Your entries are preserved; please try again.',
          });
        } else {
          setBanner({
            tone: 'danger',
            message: isZh
              ? '服务暂时繁忙，未能完成提交。您的表单内容已保留，请稍后重试。'
              : 'The service is temporarily unavailable. Your entries are preserved; please try again shortly.',
          });
        }
      } else {
        setBanner({
          tone: 'danger',
          message: isZh
            ? '提交过程中出现异常，请稍后重试。'
            : 'An unexpected error occurred while submitting. Please try again.',
        });
      }
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  };

  if (submittedSummary) {
    const pointsText = PUBLIC_PRICING_FALLBACK.demoTrial.points.toLocaleString('en-US');
    const days = PUBLIC_PRICING_FALLBACK.demoTrial.validDays;
    return (
      <div
        className="gm-mkt-success-card"
        data-testid="demo-submit-success"
        role="status"
        aria-live="polite"
      >
        <span className="gm-mkt-badge gm-mkt-badge-cited">
          {isZh ? '申请已收到' : 'Request Received'}
        </span>
        <h2 className="gm-mkt-h2">
          {isZh ? '我们已收到您的 GeoMix 试用 Demo 申请' : 'Your GeoMix Trial Demo Request Is In'}
        </h2>
        <p className="gm-mkt-lead">
          {isZh
            ? `感谢 ${submittedSummary.companyBrand} 的信任。我们的方案顾问将在人工审核后向 ${submittedSummary.email} 发送演示安排与包含 ${pointsText} 点额度（${days} 天有效）的试用租户登录信息。`
            : `Thank you for submitting ${submittedSummary.companyBrand}. Our solutions team will review your request and follow up at ${submittedSummary.email} with your demo walkthrough and ${pointsText}-point / ${days}-day Trial Demo access.`}
        </p>

        <div className="gm-mkt-success-actions">
          <Link href={isZh ? '/zh/guides' : '/guides'} className="gm-mkt-btn gm-mkt-btn-primary">
            {isZh ? '阅读 GEO 实操指南' : 'Read GEO Playbooks'}
          </Link>
          <Link
            href={isZh ? '/zh/pricing' : '/pricing'}
            className="gm-mkt-btn gm-mkt-btn-secondary"
          >
            {isZh ? '返回点数定价' : 'Back to Pricing'}
          </Link>
        </div>
      </div>
    );
  }

  const nameId = `${baseId}-name`;
  const emailId = `${baseId}-email`;
  const brandId = `${baseId}-companyBrand`;
  const websiteId = `${baseId}-websiteUrl`;
  const marketId = `${baseId}-targetMarket`;
  const goalId = `${baseId}-monthlyGoal`;
  const notesId = `${baseId}-notes`;
  const honeypotId = `${baseId}-honeypot`;

  return (
    <form className="gm-mkt-form" noValidate onSubmit={handleSubmit}>
      {estimatedPts !== undefined ? (
        <div className="gm-mkt-prefill-banner" data-testid="demo-estimated-pts-banner">
          <div>
            <span className="gm-mkt-eyebrow">
              {isZh ? '已带入预算计算器估算' : 'Calculator Estimate Attached'}
            </span>
            <p className="gm-mkt-prefill-value gm-num">
              {estimatedPts.toLocaleString('en-US')} {isZh ? '点 / 月' : 'pts / month'}
            </p>
          </div>
          <button
            type="button"
            className="gm-mkt-btn gm-mkt-btn-ghost gm-mkt-btn-sm"
            onClick={() => setEstimatedPts(undefined)}
          >
            {isZh ? '清除估算' : 'Clear'}
          </button>
        </div>
      ) : null}

      {banner ? (
        <div
          role="alert"
          className={`gm-mkt-alert ${banner.tone === 'warning' ? 'gm-mkt-alert-warning' : 'gm-mkt-alert-danger'}`}
          data-testid="demo-submit-error"
        >
          {banner.message}
        </div>
      ) : null}

      <div className="gm-mkt-form-row-2">
        <div className="gm-mkt-field">
          <label htmlFor={nameId} className="gm-mkt-label">
            {isZh ? '联系人姓名' : 'Your Name'}{' '}
            <span className="gm-mkt-required" aria-hidden="true">
              *
            </span>
          </label>
          <input
            id={nameId}
            name="name"
            type="text"
            required
            maxLength={80}
            autoComplete="name"
            className={`gm-mkt-input${fieldErrors.name ? ' is-invalid' : ''}`}
            placeholder={isZh ? '例如：林知行' : 'e.g. Alex Chen'}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              clearFieldError('name');
            }}
            aria-invalid={Boolean(fieldErrors.name)}
            aria-describedby={fieldErrors.name ? `${nameId}-err` : undefined}
          />
          {fieldErrors.name ? (
            <p id={`${nameId}-err`} className="gm-mkt-field-error" role="alert">
              {fieldErrors.name}
            </p>
          ) : null}
        </div>

        <div className="gm-mkt-field">
          <label htmlFor={emailId} className="gm-mkt-label">
            {isZh ? '工作邮箱' : 'Work Email'}{' '}
            <span className="gm-mkt-required" aria-hidden="true">
              *
            </span>
          </label>
          <input
            id={emailId}
            name="email"
            type="email"
            required
            maxLength={160}
            autoComplete="email"
            className={`gm-mkt-input${fieldErrors.email ? ' is-invalid' : ''}`}
            placeholder="alex@company.com"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              clearFieldError('email');
            }}
            aria-invalid={Boolean(fieldErrors.email)}
            aria-describedby={fieldErrors.email ? `${emailId}-err` : undefined}
          />
          {fieldErrors.email ? (
            <p id={`${emailId}-err`} className="gm-mkt-field-error" role="alert">
              {fieldErrors.email}
            </p>
          ) : null}
        </div>
      </div>

      <div className="gm-mkt-form-row-2">
        <div className="gm-mkt-field">
          <label htmlFor={brandId} className="gm-mkt-label">
            {isZh ? '公司 / 品牌名称' : 'Company or Brand Name'}{' '}
            <span className="gm-mkt-required" aria-hidden="true">
              *
            </span>
          </label>
          <input
            id={brandId}
            name="companyBrand"
            type="text"
            required
            maxLength={120}
            autoComplete="organization"
            className={`gm-mkt-input${fieldErrors.companyBrand ? ' is-invalid' : ''}`}
            placeholder={isZh ? '例如：北境声学 / NordicAudio' : 'e.g. NordicAudio'}
            value={companyBrand}
            onChange={(e) => {
              setCompanyBrand(e.target.value);
              clearFieldError('companyBrand');
            }}
            aria-invalid={Boolean(fieldErrors.companyBrand)}
            aria-describedby={fieldErrors.companyBrand ? `${brandId}-err` : undefined}
          />
          {fieldErrors.companyBrand ? (
            <p id={`${brandId}-err`} className="gm-mkt-field-error" role="alert">
              {fieldErrors.companyBrand}
            </p>
          ) : null}
        </div>

        <div className="gm-mkt-field">
          <label htmlFor={websiteId} className="gm-mkt-label">
            {isZh ? '品牌官网 URL（选填）' : 'Brand Website URL (Optional)'}
          </label>
          <input
            id={websiteId}
            name="websiteUrl"
            type="url"
            maxLength={500}
            className={`gm-mkt-input${fieldErrors.websiteUrl ? ' is-invalid' : ''}`}
            placeholder="https://yourbrand.com"
            value={websiteUrl}
            onChange={(e) => {
              setWebsiteUrl(e.target.value);
              clearFieldError('websiteUrl');
            }}
            aria-invalid={Boolean(fieldErrors.websiteUrl)}
            aria-describedby={fieldErrors.websiteUrl ? `${websiteId}-err` : undefined}
          />
          {fieldErrors.websiteUrl ? (
            <p id={`${websiteId}-err`} className="gm-mkt-field-error" role="alert">
              {fieldErrors.websiteUrl}
            </p>
          ) : null}
        </div>
      </div>

      <div className="gm-mkt-form-row-2">
        <div className="gm-mkt-field">
          <label htmlFor={marketId} className="gm-mkt-label">
            {isZh ? '目标市场' : 'Target Market'}
          </label>
          <select
            id={marketId}
            name="targetMarket"
            className={`gm-mkt-select${fieldErrors.targetMarket ? ' is-invalid' : ''}`}
            value={targetMarket}
            onChange={(e) => {
              setTargetMarket(e.target.value as MarketingLeadMarket);
              clearFieldError('targetMarket');
            }}
            aria-invalid={Boolean(fieldErrors.targetMarket)}
            aria-describedby={fieldErrors.targetMarket ? `${marketId}-err` : undefined}
          >
            {MARKETING_LEAD_MARKETS.map((market) => (
              <option key={market} value={market}>
                {isZh
                  ? MARKETING_LEAD_MARKET_LABELS[market].zh
                  : MARKETING_LEAD_MARKET_LABELS[market].en}
              </option>
            ))}
          </select>
          {fieldErrors.targetMarket ? (
            <p id={`${marketId}-err`} className="gm-mkt-field-error" role="alert">
              {fieldErrors.targetMarket}
            </p>
          ) : null}
        </div>

        <div className="gm-mkt-field">
          <label htmlFor={goalId} className="gm-mkt-label">
            {isZh ? '月度 GEO 目标（选填）' : 'Monthly GEO Goal (Optional)'}
          </label>
          <input
            id={goalId}
            name="monthlyGoal"
            type="text"
            maxLength={160}
            className={`gm-mkt-input${fieldErrors.monthlyGoal ? ' is-invalid' : ''}`}
            placeholder={
              isZh
                ? '例如：每月 8 篇母稿 + 20 核心问句双市场追踪'
                : 'e.g. 8 articles/mo + 20 tracked prompts across 4 engines'
            }
            value={monthlyGoal}
            onChange={(e) => {
              setMonthlyGoal(e.target.value);
              clearFieldError('monthlyGoal');
            }}
            aria-invalid={Boolean(fieldErrors.monthlyGoal)}
            aria-describedby={fieldErrors.monthlyGoal ? `${goalId}-err` : undefined}
          />
          {fieldErrors.monthlyGoal ? (
            <p id={`${goalId}-err`} className="gm-mkt-field-error" role="alert">
              {fieldErrors.monthlyGoal}
            </p>
          ) : null}
        </div>
      </div>

      <div className="gm-mkt-field">
        <label htmlFor={notesId} className="gm-mkt-label">
          {isZh ? '补充需求或关注场景（选填）' : 'Additional Notes or Priorities (Optional)'}
        </label>
        <textarea
          id={notesId}
          name="notes"
          rows={4}
          maxLength={2000}
          className={`gm-mkt-textarea${fieldErrors.notes ? ' is-invalid' : ''}`}
          placeholder={
            isZh
              ? '可填写您最关注的竞品词、目标 AI 引擎（如 ChatGPT / Perplexity / 豆包 / DeepSeek）或现有 CMS 渠道。'
              : 'Share priority prompts, target AI engines (ChatGPT, Perplexity, Doubao, DeepSeek), or existing CMS channels.'
          }
          value={notes}
          onChange={(e) => {
            setNotes(e.target.value);
            clearFieldError('notes');
          }}
          aria-invalid={Boolean(fieldErrors.notes)}
          aria-describedby={fieldErrors.notes ? `${notesId}-err` : undefined}
        />
        {fieldErrors.notes ? (
          <p id={`${notesId}-err`} className="gm-mkt-field-error" role="alert">
            {fieldErrors.notes}
          </p>
        ) : null}
      </div>

      {/* Visually hidden anti-spam honeypot field — intentionally not display:none */}
      <div className="gm-mkt-hp" aria-hidden="true">
        <label htmlFor={honeypotId}>Leave this field empty</label>
        <input
          id={honeypotId}
          name="honeypot"
          type="text"
          value={honeypot}
          onChange={(e) => setHoneypot(e.target.value)}
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
        />
      </div>

      <div className="gm-mkt-form-actions">
        <button
          type="submit"
          className="gm-mkt-btn gm-mkt-btn-primary gm-mkt-btn-block"
          disabled={submitting}
          aria-busy={submitting}
        >
          {submitting
            ? isZh
              ? '正在提交申请…'
              : 'Submitting Request…'
            : isZh
              ? '提交 1,000 点试用 Demo 申请'
              : 'Submit 1,000-Point Trial Demo Request'}
        </button>
      </div>
    </form>
  );
}
