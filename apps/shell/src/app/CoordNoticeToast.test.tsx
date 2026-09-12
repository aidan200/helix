// @vitest-environment jsdom
/**
 * U5 CoordNoticeToast：coord.changed 全局广播 → 活动窗口轻通知 toast。
 *
 * 直渲 daemon 人读文案（text 单源，前端零二次叙述）；escalated 用 warn
 * 提级、其余 ok。供面注入（App.gate-hold 先例）：useSession mock
 * （subscribeCoordFrames 注入面可变）+ ToastProvider 真实面（push 语义）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ToastProvider } from "@/shared/ui/Toast";
import type { EventEnvelope } from "@helix/protocol";

type Listener = (e: EventEnvelope) => void;
let coordListener: Listener | undefined;

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    subscribeCoordFrames: (fn: Listener) => {
      coordListener = fn;
      return () => {
        coordListener = undefined;
      };
    },
  }),
}));

import CoordNoticeToast from "./CoordNoticeToast";

function coordFrame(kind: string, text: string, escalated?: boolean): EventEnvelope {
  return {
    v: "0.12",
    sessionId: "__system__",
    channel: "notification",
    type: "coord.changed",
    payload: { kind, leaseId: "lease-1", ownerAgentId: "x", scopeDesc: "/ws", intent: "i", text, ...(escalated === true ? { escalated: true } : {}), ts: 1 },
  } as unknown as EventEnvelope;
}

describe("CoordNoticeToast（U5 轻通知）", () => {
  afterEach(() => {
    cleanup();
    coordListener = undefined;
  });

  it("coord.changed → toast 直渲 text（ok 档）；escalated → warn 提级", () => {
    render(
      <I18nProvider>
        <ToastProvider>
          <CoordNoticeToast />
        </ToastProvider>
      </I18nProvider>,
    );
    act(() => {
      coordListener?.(coordFrame("claimed", "x 声明占用 /ws：改调度器"));
      coordListener?.(coordFrame("conflict", "⚠ 占用冲突升级：y 再次 claim 你占用的 /ws", true));
    });
    // toast-zone DOM 渲染断言：文案在场 + kind class 分档
    const zone = document.querySelector(".toast-zone");
    expect(zone).not.toBeNull();
    const toasts = [...(zone?.querySelectorAll(".toast") ?? [])];
    expect(toasts).toHaveLength(2);
    const byText = (t: string) => toasts.find((el) => el.textContent?.includes(t));
    expect(byText("声明占用")?.className).toContain("ok"); // 轻通知 ok 档
    expect(byText("升级")?.className).toContain("warn"); // escalated 提级
  });

  it("非 coord 帧不消费", () => {
    render(
      <I18nProvider>
        <ToastProvider>
          <CoordNoticeToast />
        </ToastProvider>
      </I18nProvider>,
    );
    act(() => {
      coordListener?.({ v: "0.12", type: "task.changed", payload: {} } as unknown as EventEnvelope);
    });
    expect(document.querySelectorAll(".toast")).toHaveLength(0);
  });
});
