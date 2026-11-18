'use client';

import { useEffect } from 'react';
import type { ShellAction } from './tab-stack';

export {
  UX_TERMS,
  UX_TIMEZONE,
  VISIBILITY_TASK_STATUS_LABELS,
  containsRawCuid,
  dedupeRechargeNotice,
  formatCollectorDisplayLabel,
  formatJudgeModelDisplayLabel,
  formatShanghaiDate,
  formatShanghaiDateTime,
  formatShortDisplayId,
  isOpaqueEntityId,
  parseShanghaiDateTimeLocal,
  replaceUxJargon,
  sanitizeEntityTitleSegment,
  type FormatShanghaiDateTimeOptions,
} from '@geomix/shared';

export interface DownloadablePayload {
  filename: string;
  mime: string;
  body: Uint8Array | ArrayBuffer | Blob | string;
}

/**
 * 浏览器安全文件下载包装器：
 * - 将隐藏 `<a>` 挂载到 `document.body` 后触发点击，兼容 Firefox / Chromium / WebKit；
 * - 异步延迟释放 `URL.revokeObjectURL`，避免同步释放导致下载流被浏览器提前中断。
 */
export function triggerBlobDownload(file: DownloadablePayload, revokeDelayMs = 1500): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;

  let blob: Blob;
  if (file.body instanceof Blob) {
    blob = file.body;
  } else if (typeof file.body === 'string') {
    const needsBom = file.mime.includes('csv') && !file.body.startsWith('\uFEFF');
    blob = new Blob([needsBom ? `\uFEFF${file.body}` : file.body], { type: file.mime });
  } else if (file.body instanceof Uint8Array) {
    const copy = new Uint8Array(file.body.byteLength);
    copy.set(file.body);
    blob = new Blob([copy], { type: file.mime });
  } else {
    blob = new Blob([file.body], { type: file.mime });
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  const revoke = () => {
    if (typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(url);
    }
  };
  if (revokeDelayMs <= 0) {
    revoke();
  } else {
    window.setTimeout(revoke, revokeDelayMs);
  }
  return true;
}

const FLOATING_POPUP_SELECTOR = [
  '.ant-select-dropdown:not(.ant-select-dropdown-hidden)',
  '.ant-dropdown:not(.ant-dropdown-hidden)',
  '.ant-picker-dropdown:not(.ant-picker-dropdown-hidden)',
  '.ant-cascader-dropdown:not(.ant-cascader-dropdown-hidden)',
  '.ant-popover:not(.ant-popover-hidden)',
].join(', ');

/**
 * 检测当前文档中是否存在正在展开的下拉浮层或更高层级的 AntD Modal：
 * 当用户在弹窗内打开 `<Select>` 下拉菜单或子确认弹窗并按 `Escape` 时，
 * 只关闭上层下拉/子弹窗，避免误关底层表单弹窗。
 */
export function hasOpenFloatingOverlay(): boolean {
  if (typeof document === 'undefined') return false;
  const popups = document.querySelectorAll<HTMLElement>(FLOATING_POPUP_SELECTOR);
  for (const el of popups) {
    if (el.style.display === 'none' || el.closest('[hidden]')) continue;
    return true;
  }
  const modalWraps = document.querySelectorAll<HTMLElement>('.ant-modal-wrap');
  for (const wrap of modalWraps) {
    if (wrap.style.display === 'none' || wrap.closest('[hidden]')) continue;
    return true;
  }
  return false;
}

/**
 * 当详情页或带筛选参数的列表页加载出可读的业务实体名称后，
 * 自动同步更新多标签栏标题、`document.title` 与页内草稿便签标签，彻底消除 CUID 暴露。
 */
export function useSyncTabTitle(
  tabId: string | undefined,
  currentTitle: string,
  resolvedTitle: string | null | undefined,
  onDispatch?: (action: ShellAction) => void,
): void {
  useEffect(() => {
    if (!tabId || !onDispatch) return;
    if (!currentTitle.includes('·')) return;
    const next = resolvedTitle?.trim();
    if (!next || next === currentTitle) return;
    onDispatch({ type: 'retitle', id: tabId, title: next });
  }, [tabId, currentTitle, resolvedTitle, onDispatch]);
}
