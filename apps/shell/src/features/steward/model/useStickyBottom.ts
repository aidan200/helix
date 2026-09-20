/**
 * useStickyBottom —— 底部吸附滚动语义（管家驾驶舱批①：StewardPanel 历史锚底）。
 *
 * 对照 chat 页 MessageFlow 的滚动语义同构复用（chat 先例常量口径）：
 * - 吸附态（atBottomRef）下新内容贴底（scrollTop 直设）；
 * - 用户上滚脱附后新内容不再拽回底部（scrollTop 保持）；
 * - 滚回底部经 1s 驻留才恢复吸附（防误触阈值即拽回的抖动）；驻留期取消
 *   条件 = 用户主动滚离（scroll 事件采样——内容增长不触发 scroll 事件，
 *   驻留不被流式增长误取消）；
 * - stick()：强制贴底 + 吸附复位（打开面板/回放重建面消费）。
 *
 * 差异面（对照 MessageFlow）：无前插补偿/会话切换基线（管家面板无分页）；
 * 无驻留呼吸条视觉（chat 页专属 UX）。
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import type React from "react";

/** 贴底判定阈值（px）：距底 ≤ 40 视为在底部（MessageFlow 同口径）。 */
export const AT_BOTTOM_PX = 40;
/** 回底驻留时长（ms）：用户滚回底部后驻留满 1s 才恢复吸附。 */
export const STICK_DWELL_MS = 1000;

export interface StickyBottom {
  /** 滚动容器 ref（消费方挂到消息区根元素；null 容忍 = 卸载窗口）。 */
  ref: React.RefObject<HTMLDivElement>;
  /** 滚动监听（吸附态维护——挂到容器 onScroll）。 */
  onScroll: () => void;
  /** 强制贴底 + 吸附复位（打开面板/回放重建：无论先前是否脱附）。 */
  stick: () => void;
  /** 吸附态贴底（内容增长面：仅吸附态滚到底，脱附态零动作）。 */
  stickIfAttached: () => void;
}

export function useStickyBottom(): StickyBottom {
  const ref = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelDwell = useCallback(() => {
    if (dwellTimerRef.current !== null) {
      clearTimeout(dwellTimerRef.current);
      dwellTimerRef.current = null;
    }
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_PX;
    if (atBottomRef.current) {
      // 程序化贴底触发的 scroll 距底恒 ≈0，不会误入脱附分支
      if (!atBottom) atBottomRef.current = false;
      return;
    }
    if (!atBottom) {
      cancelDwell();
      return;
    }
    // 滚回底部 → 1s 驻留后恢复吸附（驻留期主动滚离在上方 !atBottom 分支取消）
    if (dwellTimerRef.current === null) {
      dwellTimerRef.current = setTimeout(() => {
        dwellTimerRef.current = null;
        atBottomRef.current = true;
        scrollToBottom();
      }, STICK_DWELL_MS);
    }
  }, [cancelDwell, scrollToBottom]);

  const stick = useCallback(() => {
    cancelDwell();
    atBottomRef.current = true;
    scrollToBottom();
  }, [cancelDwell, scrollToBottom]);

  const stickIfAttached = useCallback(() => {
    if (atBottomRef.current) scrollToBottom();
  }, [scrollToBottom]);

  // 卸载清驻留计时（防泄漏/卸载后回调）
  useEffect(() => cancelDwell, [cancelDwell]);

  // 返回对象身份稳定（useMemo：全体成员 useCallback 稳定——消费方 effect 依赖
  // sticky 不随每渲染新引用误触发强制贴底，破坏脱附语义）
  return useMemo(() => ({ ref, onScroll, stick, stickIfAttached }), [ref, onScroll, stick, stickIfAttached]);
}
