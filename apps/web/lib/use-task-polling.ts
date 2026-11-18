'use client';

import { useEffect, useRef } from 'react';

export const DEFAULT_TASK_POLL_INTERVAL_MS = 5_000;

export type UseTaskPollingOptions = {
  /** 是否存在需要轮询的进行中任务（如 QUEUED / RUNNING） */
  enabled: boolean;
  /** 当前多标签页是否处于前台激活态（默认 true；false 时暂停定时器） */
  active?: boolean;
  /** 轮询间隔毫秒数（默认 5000ms；<= 0 时不启动定时器） */
  intervalMs?: number;
  /** 单次轮询回调；上一轮未完成时自动跳过重叠周期 */
  onPoll: () => Promise<void> | void;
};

export function useTaskPolling({
  enabled,
  active = true,
  intervalMs = DEFAULT_TASK_POLL_INTERVAL_MS,
  onPoll,
}: UseTaskPollingOptions): void {
  const onPollRef = useRef(onPoll);
  onPollRef.current = onPoll;
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!enabled || !active || intervalMs <= 0) {
      return undefined;
    }

    let cancelled = false;
    const timer = setInterval(() => {
      if (cancelled || inFlightRef.current) {
        return;
      }
      inFlightRef.current = true;
      Promise.resolve()
        .then(() => onPollRef.current())
        .catch(() => {
          // 错误提示或静默降级由 onPoll 内部决定，避免未捕获拒绝中断后续轮询
        })
        .finally(() => {
          inFlightRef.current = false;
        });
    }, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active, enabled, intervalMs]);
}
