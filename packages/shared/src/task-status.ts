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

export function isTaskStatus(value: unknown): value is TaskStatusName {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}
