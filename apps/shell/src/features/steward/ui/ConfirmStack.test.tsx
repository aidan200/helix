// @vitest-environment jsdom
/**
 * ConfirmStack 测试（B1 管家文本链路批——左下角全局确认卡栈；设计稿
 * docs/temp/helix-steward-global-redesign.md §3.4/§1 布局图）。
 *
 * - 多卡竖排**新卡在上**；到手即编号 #1 #2…（永不重排——B2 语音指认锚点）；
 * - 超 5 张折叠「还有 N 张」抽屉（点击展开全部）；
 * - 三态：awaiting（确认/放弃钮）/ accepted（钮禁用——防双击视觉面）/
 *   done（data-state 驱动淡出）；
 * - 按钮接线：确认 → confirmCard、放弃 → cancelCard。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, act, waitFor, fireEvent } from "@testing-library/react";
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
import { STEWARD_CARD_DONE_LINGER_MS } from "../model/useStewardActions";

function frame(type: string, payload: unknown): EventEnvelope {
  return { v: "0.14", sessionId: "__system__", channel: "steward", type, payload } as EventEnvelope;
}

function pushCard(actionId: string, message = "递话内容") {
  act(() => {
    frameListener?.(
      frame("steward.ask.result", { status: "confirm_required", actionId, agentId: "agent-x", message }),
    );
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

describe("ConfirmStack（B1 左下角全局确认卡栈）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => cleanup());

  it("无卡零渲染（不占视口）", () => {
    renderStack();
    expect(screen.queryByTestId("steward-confirm-stack")).toBeNull();
  });

  it("多卡竖排新卡在上 + 到手即编号 #N", async () => {
    renderStack();
    pushCard("act-1", "第一条");
    pushCard("act-2", "第二条");
    await waitFor(() => expect(screen.getAllByTestId("steward-confirm-card").length).toBe(2));
    const seqs = screen.getAllByTestId("steward-card-seq").map((el) => el.textContent);
    expect(seqs).toEqual(["#2", "#1"]); // 新卡在上（逆序渲染）
    expect(screen.getAllByTestId("steward-confirm-card")[0]!.getAttribute("data-action-id")).toBe("act-2");
  });

  it("编号永不重排：前卡完成后后卡编号不变", async () => {
    renderStack();
    pushCard("act-1");
    pushCard("act-2");
    await waitFor(() => expect(screen.getAllByTestId("steward-confirm-card").length).toBe(2));
    // act-1 确认 → 受理 → 完成 → 淡出移除（真时序等待：linger 窗 500ms）
    act(() => {
      frameListener?.(frame("steward.confirm.result", { status: "accepted", actionId: "act-1" }));
      frameListener?.(frame("steward.action.completed", { actionId: "act-1", ok: true, detail: "已送达" }));
    });
    await waitFor(
      () => expect(screen.getAllByTestId("steward-confirm-card").length).toBe(1),
      { timeout: 3000 },
    );
    expect(screen.getAllByTestId("steward-card-seq")[0]!.textContent).toBe("#2"); // 编号不回收重排
  });

  it("超 5 张折叠「还有 N 张」；点击展开全部", async () => {
    renderStack();
    for (let i = 1; i <= 7; i += 1) pushCard(`act-${i}`, `第 ${i} 条`);
    await waitFor(() => expect(screen.getAllByTestId("steward-confirm-card").length).toBe(5));
    expect(screen.getByTestId("steward-card-more").textContent ?? "").toMatch(/2/); // 还有 2 张（i18n 数值插值）
    fireEvent.click(screen.getByTestId("steward-card-more"));
    await waitFor(() => expect(screen.getAllByTestId("steward-confirm-card").length).toBe(7));
  });

  it("三态：awaiting 按钮可点 → accepted 按钮禁用（防双击视觉面）→ done data-state", async () => {
    renderStack();
    pushCard("act-1");
    await waitFor(() => expect(screen.getAllByTestId("steward-confirm-card").length).toBe(1));
    const card = screen.getByTestId("steward-confirm-card");
    expect(card.getAttribute("data-state")).toBe("awaiting");
    // 确认按钮 → confirmCard
    fireEvent.click(screen.getByTestId("steward-card-confirm"));
    expect(sendStewardConfirm).toHaveBeenCalledWith("act-1");
    // 受理 → accepted：钮禁用
    act(() => {
      frameListener?.(frame("steward.confirm.result", { status: "accepted", actionId: "act-1" }));
    });
    await waitFor(() => expect(screen.getByTestId("steward-confirm-card").getAttribute("data-state")).toBe("accepted"));
    expect((screen.getByTestId("steward-card-confirm") as HTMLButtonElement).disabled).toBe(true); // awaiting 态钮被换为禁用钮
    // 完成 → done
    act(() => {
      frameListener?.(frame("steward.action.completed", { actionId: "act-1", ok: true, detail: "已送达" }));
    });
    await waitFor(() => expect(screen.getByTestId("steward-confirm-card").getAttribute("data-state")).toBe("done"));
  });

  it("放弃按钮 → cancelCard（本地移卡 + steward.cancel）", async () => {
    renderStack();
    pushCard("act-1");
    await waitFor(() => expect(screen.getAllByTestId("steward-confirm-card").length).toBe(1));
    fireEvent.click(screen.getByTestId("steward-card-cancel"));
    expect(sendStewardCancel).toHaveBeenCalledWith("act-1");
    await waitFor(() => expect(screen.queryByTestId("steward-confirm-card")).toBeNull());
  });
});
