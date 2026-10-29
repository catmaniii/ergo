// 页面底部的一条短提示（比如"已归档"）。正式界面和原型都用它。
// 提示里的名字占位（ASSISTANT_NAME_MARK，43 号票）显示成个人助理的名字标签。
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { NamedText } from "./assistant-name.tsx";

interface Toasts {
  toast(text: string): void;
  text?: string;
}

const ToastContext = createContext<Toasts | null>(null);

const SHOW_MS = 2600;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [text, setText] = useState<string>();
  const toast = useCallback((t: string) => {
    setText(t);
    setTimeout(() => setText((cur) => (cur === t ? undefined : cur)), SHOW_MS);
  }, []);
  const value = useMemo(() => ({ toast, text }), [toast, text]);
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

function useToasts(): Toasts {
  const t = useContext(ToastContext);
  if (!t) throw new Error("useToast 必须在 ToastProvider 里用"); // @i18n-ignore log：用错了地方的编程错误
  return t;
}

/** 弹出一条短提示 */
export function useToast(): (text: string) => void {
  return useToasts().toast;
}

/** 提示条本身：放在应用框里面（手机竖屏预览时跟着框走） */
export function ToastView() {
  const { text } = useToasts();
  if (!text) return null;
  return (
    <div className="toast" role="status">
      <NamedText text={text} />
    </div>
  );
}
