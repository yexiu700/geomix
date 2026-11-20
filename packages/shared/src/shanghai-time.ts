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

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const FIVE_DAY_WINDOW = 5;

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
    todayMidnightShanghaiAsUtcMs - (FIVE_DAY_WINDOW - 1) * DAY_MS;

  const keys: string[] = [];
  for (let i = 0; i < FIVE_DAY_WINDOW; i += 1) {
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
