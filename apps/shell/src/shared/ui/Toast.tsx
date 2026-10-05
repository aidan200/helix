/**
 * 轻量 Toast（P-1：恢复/重试成功提示，右上角（顶栏下方）；原型 toast-zone 契约）。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

export type ToastKind = "ok" | "warn" | "err" | "violet";

/** toast 行内动作钮（B1 建议导航批：「已投递到会话 X · [去看看]」——点按才
 *  切页不强切；additive，不携带钮的既有调用面零变化）。 */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
  sub?: string;
  action?: ToastAction;
}

const TOAST_LIFE_MS = 4_200;

interface ToastContextValue {
  push: (kind: ToastKind, text: string, sub?: string, action?: ToastAction) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  // 消失 timer 登记（W3 #2.35）：Provider 卸载统一 clear——卸载后 setState
  // 虽是 React 18 无害 no-op，定时器泄漏形态补齐
  const timers = useRef<Set<number>>(new Set());
  useEffect(
    () => () => {
      for (const id of timers.current) window.clearTimeout(id);
    },
    [],
  );

  const push = useCallback((kind: ToastKind, text: string, sub?: string, action?: ToastAction) => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, kind, text, sub, action }]);
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, TOAST_LIFE_MS);
    timers.current.add(timer);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-zone" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <span className="t-dot" />
            <span>
              {t.text}
              {t.sub ? <span className="t-sub">{t.sub}</span> : null}
            </span>
            {t.action && (
              <button type="button" className="t-action" data-testid="toast-action" onClick={t.action.onClick}>
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
