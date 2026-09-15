import { useEffect, useRef } from "react";

/**
 * 点外关闭 + Esc 关闭共享 hook（code-review 低危组9 收拢：三处同构 effect
 * 上提——mode-chip 菜单（P-1-top-bar）/ usage popover（SessionStats）/ web
 * 状态 popover（IconRail））。
 *
 * 契约：
 * - open=false 零监听（挂载态 popover 组件传 true 恒开——UsagePopover 先例：
 *   开合由父层条件渲染承载，组件本身即 open 态）；
 * - 指定事件（click/pointerdown，缺省 click）落在 exemptSelector 之外 →
 *   onClose（trigger 自身与 popover 内容免误关——selector 为完整 CSS 选择器，
 *   逗号并列合法）；Escape → onClose；
 * - onClose 存 ref 定格（调用方闭包陈旧性免疫——监听不随回调身份变化
 *   反复解绑/重挂）。
 */
export function useDismissOnOutside(
  open: boolean,
  exemptSelector: string,
  onClose: () => void,
  opts?: { event?: "click" | "pointerdown" },
): void {
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const eventName = opts?.event ?? "click";
    const onDismiss = (e: Event) => {
      const target = e.target as Element | null;
      if (target && typeof target.closest === "function" && target.closest(exemptSelector)) return;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    document.addEventListener(eventName, onDismiss);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener(eventName, onDismiss);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, exemptSelector, opts?.event]);
}
