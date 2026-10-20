// @vitest-environment jsdom
/**
 * 管家确认-执行-回执链路修复批：StewardNotifyToast 同内容 60s 短窗兜底
 * 去重（T6 shell 面——服务端去重叠加限流之上，shell 层同内容两条到达渲染
 * 一条；治事故「已送达后又弹两条失效投递通知」的播报面）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ToastProvider } from "@/shared/ui/Toast";
import type { EventEnvelope, StewardNotifyPayload } from "@helix/protocol";

type Listener = (e: EventEnvelope) => void;
let stewardListener: Listener | undefined;

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    subscribeStewardFrames: (fn: Listener) => {
      stewardListener = fn;
      return () => {
        stewardListener = undefined;
      };
    },
  }),
}));

import StewardNotifyToast from "./StewardNotifyToast";

function notifyFrame(payload: Partial<StewardNotifyPayload>): EventEnvelope {
  return {
    v: "0.14",
    sessionId: "__system__",
    channel: "steward",
    type: "steward.notify",
    payload: {
      urgency: "normal",
      title: "确认已超时",
      body: "操作超过 300s 未确认，已自动作废",
      seq: 1,
      ...payload,
    },
  } as unknown as EventEnvelope;
}

describe("StewardNotifyToast 兜底去重（60s 同内容短窗）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T12:25:36Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    stewardListener = undefined;
  });

  it("60s 内同内容两条到达 → 只渲染一条 toast", () => {
    render(
      <I18nProvider>
        <ToastProvider>
          <StewardNotifyToast onOpenTasks={() => undefined} />
        </ToastProvider>
      </I18nProvider>,
    );
    act(() => {
      stewardListener?.(notifyFrame({ seq: 1 }));
      stewardListener?.(notifyFrame({ seq: 2 })); // 服务端去重失效/多路径兜底
    });
    const toasts = [...document.querySelectorAll(".toast")];
    expect(toasts).toHaveLength(1);
  });

  it("容量挤出按真 LRU：高频复现的键不占挤出位（先摘后插保新鲜）", () => {
    render(
      <I18nProvider>
        <ToastProvider>
          <StewardNotifyToast onOpenTasks={() => undefined} />
        </ToastProvider>
      </I18nProvider>,
    );
    const key = (i: number) => ({ title: `通知${i}`, body: `内容${i}` });
    // 填满容量窗（32 键）
    act(() => {
      for (let i = 0; i < 32; i++) stewardListener?.(notifyFrame(key(i)));
    });
    // 复现 k0（窗内命中：去重短路，但 LRU 位置应刷新到队尾）
    act(() => {
      stewardListener?.(notifyFrame(key(0)));
    });
    // 新增第 33 键触发挤出：旧实现按插入序挤掉 k0，修后挤掉最久未用的 k1
    act(() => {
      stewardListener?.(notifyFrame(key(99)));
    });
    // k0 仍在窗内 → 同内容再达仍去重（toast 里「通知0」只出现一次）
    act(() => {
      stewardListener?.(notifyFrame(key(0)));
    });
    const k0Toasts = [...document.querySelectorAll(".toast")].filter((t) =>
      t.textContent?.includes("通知0"),
    );
    expect(k0Toasts).toHaveLength(1);
    // 对照：k1 已被挤出窗口 → 同内容再达渲染新 toast
    act(() => {
      stewardListener?.(notifyFrame(key(1)));
    });
    const k1Toasts = [...document.querySelectorAll(".toast")].filter((t) =>
      t.textContent?.includes("通知1"),
    );
    expect(k1Toasts.length).toBeGreaterThan(1);
  });

  it("60s 窗外同内容再达 → 渲染第二条；不同内容不受影响", () => {
    render(
      <I18nProvider>
        <ToastProvider>
          <StewardNotifyToast onOpenTasks={() => undefined} />
        </ToastProvider>
      </I18nProvider>,
    );
    act(() => {
      stewardListener?.(notifyFrame({ seq: 1 }));
    });
    vi.advanceTimersByTime(61_000);
    act(() => {
      stewardListener?.(notifyFrame({ seq: 2 }));
      stewardListener?.(notifyFrame({ seq: 3, title: "任务完成", body: "另一件事" }));
    });
    const toasts = [...document.querySelectorAll(".toast")];
    expect(toasts).toHaveLength(2);
    expect(toasts.some((t) => t.textContent?.includes("任务完成"))).toBe(true);
  });
});
