'use client';

import { App, Modal, message as staticMessage, type ModalFuncProps } from 'antd';
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';

const UxFeedbackMountedContext = createContext<boolean>(false);

export function UxFeedbackProvider({ children }: { children: ReactNode }) {
  return (
    <UxFeedbackMountedContext.Provider value={true}>{children}</UxFeedbackMountedContext.Provider>
  );
}

export interface UxFeedbackApi {
  confirm: (props: ModalFuncProps) => void;
  notifySuccess: (text: string) => void;
  notifyWarning: (text: string) => void;
  notifyError: (text: string) => void;
}

/**
 * 统一深色主题反馈与确认弹窗入口：
 * - 在真实应用（包裹 `<AppProviders>`）中走 `App.useApp()`，自动继承暗黑主题 `GM_ANTD_THEME` 与键盘 ESC 关闭；
 * - 在未挂载 `<AppProviders>` 的独立组件单测中平滑回退至静态 `Modal` / `message`，保障单测零侵入兼容。
 */
export function useUxFeedback(): UxFeedbackApi {
  const insideApp = useContext(UxFeedbackMountedContext);
  const app = App.useApp();

  const confirm = useCallback(
    (props: ModalFuncProps) => {
      const merged: ModalFuncProps = {
        keyboard: true,
        centered: true,
        maskClosable: false,
        okText: props.okText ?? '确定',
        cancelText: props.cancelText ?? '取消',
        ...props,
      };
      if (insideApp && typeof app.modal?.confirm === 'function') {
        app.modal.confirm(merged);
        return;
      }
      // eslint-disable-next-line no-restricted-syntax -- Intentional unit-test fallback when rendered outside AppProviders
      Modal.confirm(merged);
    },
    [app.modal, insideApp],
  );

  const notifySuccess = useCallback(
    (text: string) => {
      if (insideApp && typeof app.message?.success === 'function') {
        void app.message.success(text);
        return;
      }
      void staticMessage.success(text);
    },
    [app.message, insideApp],
  );

  const notifyWarning = useCallback(
    (text: string) => {
      if (insideApp && typeof app.message?.warning === 'function') {
        void app.message.warning(text);
        return;
      }
      void staticMessage.warning(text);
    },
    [app.message, insideApp],
  );

  const notifyError = useCallback(
    (text: string) => {
      if (insideApp && typeof app.message?.error === 'function') {
        void app.message.error(text);
        return;
      }
      void staticMessage.error(text);
    },
    [app.message, insideApp],
  );

  return useMemo(
    () => ({
      confirm,
      notifySuccess,
      notifyWarning,
      notifyError,
    }),
    [confirm, notifyError, notifySuccess, notifyWarning],
  );
}
