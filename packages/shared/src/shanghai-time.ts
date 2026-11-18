/**
 * 北京时间（Asia/Shanghai, UTC+8）输入解析工具
 * - 用于将前端 `<input type="datetime-local">` 或 `<input type="date">` 的本地输入值
 *   按固定 UTC+8（+08:00）语义解析为标准 UTC ISO-8601 时间戳，避免依赖客户端操作系统时区。
 */

const DATETIME_LOCAL_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const EXPLICIT_TZ_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * 将 `datetime-local`（`YYYY-MM-DDTHH:mm` / `YYYY-MM-DDTHH:mm:ss`）或日期字符串
 * 按北京时间（UTC+8）解析为 UTC ISO 字符串；空值或非法格式返回 `null`。
 */
export function parseShanghaiDateTimeLocal(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (EXPLICIT_TZ_RE.test(trimmed)) {
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  const dtMatch = DATETIME_LOCAL_RE.exec(trimmed);
  if (dtMatch) {
    const [, y, m, d, hh, mm, ss = '00', ms] = dtMatch;
    const msPart = ms ? `.${ms.padEnd(3, '0')}` : '';
    const candidate = new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}${msPart}+08:00`);
    if (Number.isNaN(candidate.getTime())) return null;
    // Verify calendar fields didn't roll over (e.g. Feb 30)
    const shanghaiDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(candidate);
    if (shanghaiDate !== `${y}-${m}-${d}`) return null;
    return candidate.toISOString();
  }

  const dateMatch = DATE_ONLY_RE.exec(trimmed);
  if (dateMatch) {
    const [, y, m, d] = dateMatch;
    const candidate = new Date(`${y}-${m}-${d}T00:00:00.000+08:00`);
    if (Number.isNaN(candidate.getTime())) return null;
    const shanghaiDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(candidate);
    if (shanghaiDate !== `${y}-${m}-${d}`) return null;
    return candidate.toISOString();
  }

  return null;
}
