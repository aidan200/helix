// @vitest-environment jsdom
/**
 * useStewardActions 测试（B1 管家文本链路批——全局确认卡栈数据面；设计稿
 * docs/temp/helix-steward-global-redesign.md §3.4）。
 *
 * - 多卡并存：confirm_required 与 sediment_proposal 各自入栈不互相覆盖
 *   （G4 单槽覆盖消除）；到手编号 #1 #2… 单调递增；
 * - 三态流转：confirm → awaiting；confirm.result{accepted} → accepted；
 *   action.completed → done + 淡出窗后移除（fake timers）；
 * - 防双击：accepted 态 confirmCard 返回 false 且不重复发帧；
 * - 放弃：cancelCard → sendStewardCancel + 本地移卡；
 * - confirm.result{error}（多窗口竞态）→ 在途卡移除。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, act, waitFor } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ToastProvider } from "@/shared/ui/Toast";
import type { EventEnvelope } from "@helix/protocol";

const sendStewardConfirm = vi.fn(() => true);
const sendStewardCancel = vi.fn(() => true);
let frameListener: ((e: EventEnvelope) => void) | null = null;
const subscribeStewardFrames = vi.fn((cb: (e: EventEnvelope) => void) => {
  frameListener = cb;
  return () => {
    frameListener = null;
  };
});

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    sendStewardConfirm,
    sendStewardCancel,
    subscribeStewardFrames,
  }),
}));

import { useStewardActions, STEWARD_CARD_DONE_LINGER_MS } from "./useStewardActions";

function frame(type: string, payload: unknown): EventEnvelope {
  return { v: "0.14", sessionId: "__system__", channel: "steward", type, payload } as EventEnvelope;
}

function renderActions() {
  return renderHook(() => useStewardActions(), {
    wrapper: ({ children }) => (
      <I18nProvider>
        <ToastProvider>{children}</ToastProvider>
      </I18nProvider>
    ),
  });
}

describe("useStewardActions（B1 全局确认卡栈数据面）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true }); // waitFor 轮询可推进（fake timers 兼容）
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("多卡并存不覆盖：confirm_required 与 sediment_proposal 各自入栈 + 编号单调递增", async () => {
    const { result } = renderActions();
    act(() => {
      frameListener?.(
        frame("steward.ask.result", {
          status: "confirm_required",
          actionId: "act-1",
          agentId: "agent-1",
          message: "顺带跑 lint",
        }),
      );
    });
    act(() => {
      frameListener?.(frame("steward.sediment_proposal", { actionId: "act-2", text: "记住这个偏好", kind: "preference" }));
    });
    await waitFor(() => expect(result.current.cards.length).toBe(2));
    // 互不覆盖（B1 前单槽 pending 会被后者挤掉——G4）
    expect(result.current.cards[0]).toMatchObject({ actionId: "act-1", state: "awaiting" });
    expect(result.current.cards[1]).toMatchObject({ actionId: "act-2", state: "awaiting" });
    // 到手编号单调
    expect(result.current.cards[0]!.seq).toBe(1);
    expect(result.current.cards[1]!.seq).toBe(2);
    // sediment 卡 agentId 语义重载（长期记忆目标）+ 提案文案
    expect(result.current.cards[1]!.agentId).toMatch(/长期记忆|Long-term memory/);
    expect(result.current.cards[1]!.message).toContain("记住这个偏好");
  });

  it("三态流转：confirm → accepted（受理）→ action.completed → done + 淡出窗后移除", async () => {
    const { result } = renderActions();
    act(() => {
      frameListener?.(
        frame("steward.ask.result", { status: "confirm_required", actionId: "act-1", agentId: "agent-1", message: "递话" }),
      );
    });
    await waitFor(() => expect(result.current.cards.length).toBe(1));
    // 确认：发 steward.confirm
    act(() => {
      expect(result.current.confirmCard("act-1")).toBe(true);
    });
    expect(sendStewardConfirm).toHaveBeenCalledWith("act-1");
    // 受理回执 → accepted
    act(() => {
      frameListener?.(frame("steward.confirm.result", { status: "accepted", actionId: "act-1" }));
    });
    await waitFor(() => expect(result.current.cards[0]!.state).toBe("accepted"));
    // 完成帧 → done + 结果 toast + 淡出窗后移除
    act(() => {
      frameListener?.(frame("steward.action.completed", { actionId: "act-1", ok: true, detail: "已注入目标会话" }));
    });
    await waitFor(() => expect(result.current.cards[0]!.state).toBe("done"));
    act(() => {
      vi.advanceTimersByTime(STEWARD_CARD_DONE_LINGER_MS + 50);
    });
    await waitFor(() => expect(result.current.cards.length).toBe(0));
  });

  it("防双击：accepted 态 confirmCard 返回 false 且不重复发帧", async () => {
    const { result } = renderActions();
    act(() => {
      frameListener?.(
        frame("steward.ask.result", { status: "confirm_required", actionId: "act-1", agentId: "agent-1", message: "递话" }),
      );
    });
    await waitFor(() => expect(result.current.cards.length).toBe(1));
    act(() => {
      frameListener?.(frame("steward.confirm.result", { status: "accepted", actionId: "act-1" }));
    });
    await waitFor(() => expect(result.current.cards[0]!.state).toBe("accepted"));
    expect(result.current.confirmCard("act-1")).toBe(false);
    expect(sendStewardConfirm).not.toHaveBeenCalled(); // 全程零确认帧（accepted 由他窗/竞态到达——本面未发起也拦）
  });

  it("防双击（受理前）：confirmCard 后卡仍 awaiting 时可被再点——受理回执未到前二击不炸", async () => {
    const { result } = renderActions();
    act(() => {
      frameListener?.(
        frame("steward.ask.result", { status: "confirm_required", actionId: "act-1", agentId: "agent-1", message: "递话" }),
      );
    });
    await waitFor(() => expect(result.current.cards.length).toBe(1));
    expect(result.current.confirmCard("act-1")).toBe(true);
    // UI 钮在 awaiting→accepted 间隙（受理回执未达）仍是可点态——数据面不拦
    // 第二击（daemon 侧单次消费会拒绝；受理回执到达即禁用——主防线）
    expect(result.current.confirmCard("act-1")).toBe(true);
    expect(sendStewardConfirm).toHaveBeenCalledTimes(2);
  });

  it("放弃：cancelCard → 本地移卡 + sendStewardCancel（daemon 侧作废）", async () => {
    const { result } = renderActions();
    act(() => {
      frameListener?.(
        frame("steward.ask.result", { status: "confirm_required", actionId: "act-1", agentId: "agent-1", message: "递话" }),
      );
    });
    await waitFor(() => expect(result.current.cards.length).toBe(1));
    act(() => {
      result.current.cancelCard("act-1");
    });
    expect(sendStewardCancel).toHaveBeenCalledWith("act-1");
    await waitFor(() => expect(result.current.cards.length).toBe(0));
  });

  it("confirm.result error（多窗口竞态/已消费）→ 本连接在途 awaiting 卡移除", async () => {
    const { result } = renderActions();
    act(() => {
      frameListener?.(
        frame("steward.ask.result", { status: "confirm_required", actionId: "act-1", agentId: "agent-1", message: "递话" }),
      );
    });
    act(() => {
      frameListener?.(
        frame("steward.ask.result", { status: "confirm_required", actionId: "act-2", agentId: "agent-2", message: "递话二" }),
      );
    });
    await waitFor(() => expect(result.current.cards.length).toBe(2));
    act(() => {
      result.current.confirmCard("act-1");
    });
    act(() => {
      frameListener?.(frame("steward.confirm.result", { status: "error", reason: "待确认动作不存在或已消费" }));
    });
    await waitFor(() => expect(result.current.cards.length).toBe(1));
    expect(result.current.cards[0]!.actionId).toBe("act-2"); // 误伤排查：他卡保留
  });
});
