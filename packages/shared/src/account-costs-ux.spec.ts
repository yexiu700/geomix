import { describe, expect, it } from 'vitest';
import {
  buildImageLedgerTitle,
  containsLedgerReasoningLeak,
  formatCountNumber,
  formatLlmModelDisplayLabel,
  formatLlmProviderDisplayLabel,
  formatLlmTenantDisplayName,
  formatYuanAmount,
  sanitizeLedgerRemark,
  sanitizeLedgerTitle,
} from './account-costs-ux';

describe('account-costs-ux (#201, #202)', () => {
  it('sanitizes CoT reasoning leakage from ledger titles while preserving valid prefixes and shadow suffix', () => {
    expect(sanitizeLedgerTitle('AI生图-用户需要把简短描述扩写成配图提示词，80-220（免费期）')).toBe(
      'AI生图（免费期）',
    );
    expect(
      sanitizeLedgerTitle(
        'AI生图-<think>首先分析用户的描述，硬性约束是不出现真人正脸</think>木质咖啡桌（免费期）',
      ),
    ).toBe('AI生图（免费期）');
    expect(sanitizeLedgerTitle('AI写作-首先拆解用户需求，遵守以下规则：不输出引号（免费期）')).toBe(
      'AI写作（免费期）',
    );
    expect(sanitizeLedgerTitle('AI生图-写实商业摄影浅色木桌（免费期）')).toBe(
      'AI生图-写实商业摄影浅色木桌（免费期）',
    );
    expect(sanitizeLedgerTitle('GEO写作-2026 NAS选购指南（免费期）')).toBe(
      'GEO写作-2026 NAS选购指南（免费期）',
    );
    expect(sanitizeLedgerTitle('行内AI配图-<think>思考过程</think>（免费期）')).toBe(
      '行内AI配图（免费期）',
    );
    expect(sanitizeLedgerTitle('管理员充值')).toBe('管理员充值');
    expect(containsLedgerReasoningLeak('用户需要把简短描述扩写成配图提示词')).toBe(true);
    expect(containsLedgerReasoningLeak('木质桌面极简工业产品实拍')).toBe(false);
  });

  it('builds safe AI image ledger titles without CoT prompt leakage', () => {
    expect(buildImageLedgerTitle('用户需要把简短描述扩写成配图提示词，80-220字')).toBe('AI生图');
    expect(buildImageLedgerTitle('<think>思考过程...</think>')).toBe('AI生图');
    expect(buildImageLedgerTitle('极简工业激光切割设备车间实拍图')).toBe(
      'AI生图-极简工业激光切割设备车间实拍图',
    );
  });

  it('sanitizes ledger remarks and internal jargon', () => {
    expect(sanitizeLedgerRemark('影子计费期间人工补录')).toBe('免费体验期间人工补录');
    expect(sanitizeLedgerRemark('<think>内部推理过程</think>')).toBe('系统结算记录');
    expect(sanitizeLedgerRemark('')).toBe('');
  });

  it('masks fake providers/models and raw tenant CUIDs for admin cost reports', () => {
    expect(formatLlmProviderDisplayLabel('fake', true)).toBe('内置模拟引擎');
    expect(formatLlmProviderDisplayLabel('deepseek', false)).toBe('deepseek');

    expect(formatLlmModelDisplayLabel('fake-quality', true)).toBe('内置高质量模拟');
    expect(formatLlmModelDisplayLabel('fake-cheap', true)).toBe('内置轻量模拟');
    expect(formatLlmModelDisplayLabel('deterministic-fallback', true)).toBe('内置模拟模型');
    expect(formatLlmModelDisplayLabel('deepseek-chat', false)).toBe('deepseek-chat');

    const rawCuid = 'cmwkm6lyw001g14g2qj5t1xxb';
    expect(formatLlmTenantDisplayName(rawCuid, rawCuid)).toBe('租户 #5T1XXB');
    expect(formatLlmTenantDisplayName(null, rawCuid)).toBe('租户 #5T1XXB');
    expect(formatLlmTenantDisplayName('苏州智造激光', rawCuid)).toBe('苏州智造激光');
    expect(formatLlmTenantDisplayName(null, 'system')).toBe('系统任务');
  });

  it('formats counts and Yuan amounts consistently with thousand separators', () => {
    expect(formatCountNumber(1234567)).toBe('1,234,567');
    expect(formatCountNumber(null)).toBe('0');
    expect(formatYuanAmount('1234.5678')).toBe('¥1,234.5678');
    expect(formatYuanAmount('0.0240')).toBe('¥0.0240');
    expect(formatYuanAmount('-1050.50')).toBe('-¥1,050.50');
  });
});
