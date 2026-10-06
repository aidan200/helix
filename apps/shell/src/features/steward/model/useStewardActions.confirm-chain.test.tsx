// @vitest-environment jsdom
/**
 * 管家确认-执行-回执链路修复批 shell 侧（TDD 红→绿）：
 * - confirm_required 幂等去重（daemon 登记簿复用旧卡 → 同 actionId 帧重放，
 *   shell 卡栈不重复弹卡——治事故「六卡并存」的呈现面）；
 * - steward.pending.snapshot 清场/对账（daemon 重启后快照空集 → shell 撤
 *   全部旧卡，E-206 跨重启残项收编）；
 * - steward.action.completed {outcome:"superseded"} 收敛帧静默移卡（零
 *   toast 零留痕——治「已送达后又弹两条失效投递通知」）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, act, waitFor } from "@testing-library/react";
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

import ConfirmStack from "../ui/ConfirmStack";

function frame(type: string, payload: unknown): EventEnvelope {
  return { v: "0.14", sessionId: "__system__", channel: "steward", type, payload } as EventEnvelope;
}

function pushCard(actionId: string, message = "重启部署服务并验证健康检查") {
  act(() => {
    frameListener?.(
      frame("steward.ask.result", { status: "confirm_required", actionId, agentId: "agent-1", message }),
    );
  });
}

function pushMemoryCard() {
  act(() => {
    frameListener?.(frame("steward.memory_written", { text: "用户偏好简洁回复", mode: "added" }));
  });
}

function renderStack() {
  return render(
    <I18nProvider>
      <ToastProvider>
        <ConfirmStack />
      </ToastProvider>
    </I18nProvider>,
  );
}

function cardIds(): string[] {
  return screen
    .getAllByTestId("steward-confirm-card")
    .map((el) => el.getAttribute("data-action-id") ?? "");
}

describe("确认链路修复 shell 面（幂等去重/清场对账/收敛静默）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => cleanup());

  it("confirm_required 同 actionId 帧重放 → 卡栈幂等（daemon 复用旧卡不重复弹）", async () => {
    renderStack();
    pushCard("steward-action-1");
    pushCard("steward-action-1"); // daemon 登记簿复用路径的同 actionId 回执
    await waitFor(() => expect(screen.getAllByTestId("steward-confirm-card").length).toBe(1));
    expect(cardIds()).toEqual(["steward-action-1"]);
  });

  it("pending.snapshot 空集（daemon 重启清场）→ 卡栈全部旧卡撤除", async () => {
    renderStack();
    pushCard("steward-action-1");
    pushCard("steward-action-2");
    pushMemoryCard();
    await waitFor(() => expect(screen.getAllByTestId("steward-confirm-card").length).toBe(2));

    act(() => {
      frameListener?.(frame("steward.pending.snapshot", { actionIds: [] }));
    });
    await waitFor(() => expect(screen.queryAllByTestId("steward-confirm-card").length).toBe(0));
    // memory 通知卡不受对账影响（无确认语义——自动淡出归自身驻留窗）
    expect(screen.getAllByTestId("steward-memory-card").length).toBe(1);
  });

  it("pending.snapshot 非全集对账：不在快照内的卡撤除、在册卡保留", async () => {
    renderStack();
    pushCard("steward-action-1");
    pushCard("steward-action-2");
    await waitFor(() => expect(screen.getAllByTestId("steward-confirm-card").length).toBe(2));

    act(() => {
      frameListener?.(frame("steward.pending.snapshot", { actionIds: ["steward-action-2"] }));
    });
    await waitFor(() => expect(cardIds()).toEqual(["steward-action-2"]));
  });

  it("action.completed {outcome:superseded} → 卡静默移除（零 toast——失效投递通知治理）", async () => {
    renderStack();
    pushCard("steward-action-1");
    pushCard("steward-action-2");
    await waitFor(() => expect(screen.getAllByTestId("steward-confirm-card").length).toBe(2));

    act(() => {
      frameListener?.(
        frame("steward.action.completed", {
          actionId: "steward-action-2",
          ok: false,
          detail: "该操作已由其它确认收敛",
          outcome: "superseded",
        }),
      );
    });
    await waitFor(() => expect(cardIds()).toEqual(["steward-action-1"]));
    // 静默：不弹任何 toast（收敛帧非用户事件）
    await waitFor(() => expect(document.querySelectorAll(".toast").length).toBe(0));
  });

  it("action.completed 无 outcome（正常执行回执）→ 行为不变（done 态 + toast 交代）", async () => {
    renderStack();
    pushCard("steward-action-1");
    await waitFor(() => expect(screen.getAllByTestId("steward-confirm-card").length).toBe(1));

    act(() => {
      frameListener?.(frame("steward.action.completed", { actionId: "steward-action-1", ok: true, detail: "已送达" }));
    });
    await waitFor(() =>
      expect(screen.getByTestId("steward-confirm-card").getAttribute("data-state")).toBe("done"),
    );
    await waitFor(() => expect(document.querySelectorAll(".toast").length).toBe(1));
  });
});
