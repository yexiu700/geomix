import { SITE_NAME } from '@geomix/shared';

export const SHELL_ANNOUNCEMENT = `${SITE_NAME} 公告：请使用自有或已授权的素材。账号到期后可以查看，不能修改资料。`;

export function displayName(account: { nickname: string | null; username: string }): string {
  const nickname = account.nickname?.trim();
  if (nickname) return nickname;
  return account.username;
}

export function formatExpiry(iso: string, readOnly: boolean): string {
  const date = iso.slice(0, 10);
  if (readOnly) return `已到期 · 只读 · ${date}`;
  return `有效期至 ${date}`;
}

export const MODULE_PLACEHOLDER =
  '这一页的业务数据还在后续模块。下面的草稿会留在当前标签里；刷新这个标签会清空草稿。';
