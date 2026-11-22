export const TASK_STATUSES = [
  'QUEUED',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'PARTIAL',
  'FAILED',
  'CANCELLED',
] as const;
export type TaskStatusName = (typeof TASK_STATUSES)[number];

export const ITEM_STATUSES = ['PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'SKIPPED'] as const;
export type ItemStatusName = (typeof ITEM_STATUSES)[number];

export const TASK_STATUS_LABELS: Record<TaskStatusName, string> = {
  QUEUED: '排队中',
  RUNNING: '创作中',
  PAUSED: '已暂停',
  COMPLETED: '创作完成',
  PARTIAL: '部分完成',
  FAILED: '失败',
  CANCELLED: '已终止',
};

export const ITEM_STATUS_LABELS: Record<ItemStatusName, string> = {
  PENDING: '待执行',
  RUNNING: '生成中',
  SUCCESS: '已完成',
  FAILED: '失败',
  SKIPPED: '已跳过',
};

export function isTaskStatus(value: unknown): value is TaskStatusName {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}
