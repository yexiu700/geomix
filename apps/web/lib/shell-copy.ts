import { formatShanghaiDate, SITE_NAME } from '@geomix/shared';

export const SHELL_ANNOUNCEMENT = `${SITE_NAME} 公告：请使用自有或已授权的素材。账号到期后可以查看，不能修改资料。`;

export function displayName(account: { nickname: string | null; username: string }): string {
  const nickname = account.nickname?.trim();
  if (nickname) return nickname;
  return account.username;
}

export function formatExpiry(iso: string, readOnly: boolean): string {
  const date = formatShanghaiDate(iso);
  if (readOnly) return `已到期 · 只读 · ${date}`;
  return `有效期：${date}`;
}
