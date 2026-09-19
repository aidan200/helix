// @vitest-environment jsdom
/**
 * StewardPanel 测试（V2.5 文本管家批；mock conn/命令面——确认按钮交互路径）。
 *
 * - 渲染面：开启态渲染面板壳（标题/输入框/发送钮）；未启用（config null 或
 *   enabled=false）→ 渲染占位（开关引导，不渲染输入面）；
 * - 发送路径：输入 → 点击发送 → sendStewardAsk 发出 + 本地 user 气泡；
 * - Markdown 渲染（V2.5 体验批）：steward 气泡用 MarkdownMessage（加粗/行内
 *   code/代码块渲染）；user 气泡保持纯文本（与主聊天同口径）；流式期间
 *   （askInFlight + streamingText）显示流式气泡而非「思考中」占位；
 * - 确认闸路径：confirm_required 态 → 确认卡全文展示（agentId + message）；
 *   点击确认 → sendStewardConfirm(actionId)；未点确认零发送；
 * - feed 行渲染：steward.feed → 文本行出现在事件流区。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import type { EventEnvelope } from "@helix/protocol";

const sendStewardAsk = vi.fn(() => true);
const sendStewardConfirm = vi.fn(() => true);
const sendStewardSubscribe = vi.fn(() => true);
const sendStewardUnsubscribe = vi.fn(() => true);
const sendStewardGetConfig = vi.fn(() => true);
// 多听众扇出（V3a：面板内 useSteward 与朗读闸两订阅者——真实 LISTEN_SURFACE
// 形态；单 ref 只存末位订阅者会吞帧）
const stewardListeners = new Set<(e: EventEnvelope) => void>();
const subscribeStewardFrames = vi.fn((cb: (e: EventEnvelope) => void) => {
  stewardListeners.add(cb);
  return () => {
    stewardListeners.delete(cb);
  };
});
function emitSteward(e: EventEnvelope): void {
  for (const l of stewardListeners) l(e);
}

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    topology: { active: { conn: "connected" } },
    sendStewardAsk,
    sendStewardConfirm,
    sendStewardSubscribe,
    sendStewardUnsubscribe,
    sendStewardGetConfig,
    subscribeStewardFrames,
  }),
}));

import StewardPanel from "../ui/StewardPanel";

function frame(type: string, payload: unknown): EventEnvelope {
  return { v: "0.13", sessionId: "__system__", channel: "steward", type, payload } as EventEnvelope;
}

function renderPanel() {
  return render(
    <I18nProvider>
      <StewardPanel onClose={() => undefined} />
    </I18nProvider>,
  );
}

describe("StewardPanel（V2.5 管家面板）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => cleanup());

  it("开启态：渲染面板壳 + 输入面；config.result(enabled) 后可见", async () => {
    renderPanel();
    act(() => {
      emitSteward(frame("steward.config.result", { enabled: true, model: "deepseek/deepseek-v4-flash" }));
    });
    await waitFor(() => {
      expect(screen.getByTestId("steward-panel")).toBeTruthy();
    });
    expect(screen.getByTestId("steward-input")).toBeTruthy();
    expect(screen.getByTestId("steward-send")).toBeTruthy();
  });

  it("未启用：渲染关闭引导（无输入面）", async () => {
    renderPanel();
    act(() => {
      emitSteward(frame("steward.config.result", { enabled: false, model: "x" }));
    });
    await waitFor(() => {
      expect(screen.getByTestId("steward-disabled")).toBeTruthy();
    });
    expect(screen.queryByTestId("steward-input")).toBeNull();
  });

  it("发送路径：输入 + 点击发送 → sendStewardAsk + user 气泡", async () => {
    renderPanel();
    act(() => {
      emitSteward(frame("steward.config.result", { enabled: true, model: "x/y" }));
    });
    await waitFor(() => expect(screen.getByTestId("steward-input")).toBeTruthy());
    fireEvent.change(screen.getByTestId("steward-input"), { target: { value: "现在有什么在跑？" } });
    fireEvent.click(screen.getByTestId("steward-send"));
    expect(sendStewardAsk).toHaveBeenCalledWith("现在有什么在跑？");
    await waitFor(() => expect(screen.getByTestId("steward-msg-user").textContent).toContain("在跑"));
  });

  it("确认闸路径：confirm_required → 全文确认卡；点确认 → sendStewardConfirm(actionId)；未点零发送", async () => {
    renderPanel();
    act(() => {
      emitSteward(frame("steward.config.result", { enabled: true, model: "x/y" }));
    });
    act(() => {
      emitSteward(
        frame("steward.ask.result", {
          status: "confirm_required",
          actionId: "steward-action-9",
          agentId: "agent-1",
          message: "顺带跑一下 lint",
        }),
      );
    });
    const card = await waitFor(() => screen.getByTestId("steward-confirm-card"));
    expect(card.textContent).toContain("agent-1");
    expect(card.textContent).toContain("顺带跑一下 lint");
    expect(sendStewardConfirm).not.toHaveBeenCalled(); // 未点确认零执行
    fireEvent.click(screen.getByTestId("steward-confirm-yes"));
    expect(sendStewardConfirm).toHaveBeenCalledWith("steward-action-9");
  });

  it("feed 行渲染：steward.feed → 事件流区文本行", async () => {
    renderPanel();
    act(() => {
      emitSteward(frame("steward.config.result", { enabled: true, model: "x/y" }));
    });
    act(() => {
      emitSteward(frame("steward.feed", { kind: "agent.completed", agentId: "agent-2", text: "agent-2 已完成：修复登录超时", seq: 1 }));
    });
    await waitFor(() => {
      expect(screen.getByTestId("steward-feed").textContent).toContain("修复登录超时");
    });
  });

  it("Markdown 渲染：steward 气泡渲染加粗/行内 code（V2.5 体验批）；user 气泡保持纯文本", async () => {
    renderPanel();
    act(() => {
      emitSteward(frame("steward.config.result", { enabled: true, model: "x/y" }));
    });
    act(() => {
      emitSteward(
        frame("steward.ask.result", {
          status: "answer",
          text: "当前 **2 个**实例运行中，用 `list_instances` 查询。\n\n- agent-1\n- agent-2",
        }),
      );
    });
    const stewardMsg = await waitFor(() => screen.getByTestId("steward-msg-steward"));
    // Markdown 元素存在：加粗 strong / 行内 code chip / 无序列表
    expect(stewardMsg.querySelector("strong")).toBeTruthy();
    expect(stewardMsg.querySelector("code")).toBeTruthy();
    expect(stewardMsg.querySelectorAll("li").length).toBe(2);
    // 原始 md 语法不出现在文本里（已渲染，非纯文本直出）
    expect(stewardMsg.textContent).toContain("2 个");
    expect(stewardMsg.textContent).not.toContain("**");
  });

  it("user 气泡纯文本：**星号** 原样直出（不渲染 md）", async () => {
    renderPanel();
    act(() => {
      emitSteward(frame("steward.config.result", { enabled: true, model: "x/y" }));
    });
    await waitFor(() => expect(screen.getByTestId("steward-input")).toBeTruthy());
    fireEvent.change(screen.getByTestId("steward-input"), { target: { value: "**加粗问句**" } });
    fireEvent.click(screen.getByTestId("steward-send"));
    const userMsg = await waitFor(() => screen.getByTestId("steward-msg-user"));
    expect(userMsg.querySelector("strong")).toBeNull(); // 纯文本：星号原样
    expect(userMsg.textContent).toContain("**加粗问句**");
  });

  it("流式气泡：delta 到达 → 流式气泡渲染 Markdown（替代「思考中」占位）", async () => {
    renderPanel();
    act(() => {
      emitSteward(frame("steward.config.result", { enabled: true, model: "x/y" }));
    });
    await waitFor(() => expect(screen.getByTestId("steward-input")).toBeTruthy());
    fireEvent.change(screen.getByTestId("steward-input"), { target: { value: "在跑什么？" } });
    fireEvent.click(screen.getByTestId("steward-send"));
    // 无 delta：思考中占位
    await waitFor(() => expect(screen.getByTestId("steward-inflight")).toBeTruthy());
    act(() => {
      emitSteward(frame("steward.ask.delta", { delta: "当前 ", seq: 1 }));
      emitSteward(frame("steward.ask.delta", { delta: "**2 个**", seq: 2 }));
    });
    const streamBubble = await waitFor(() => screen.getByTestId("steward-msg-streaming"));
    expect(streamBubble.querySelector("strong")).toBeTruthy(); // 流式态即 md 渲染
    expect(screen.queryByTestId("steward-inflight")).toBeNull(); // 占位退场
    // 终态：流式气泡换成权威消息
    act(() => {
      emitSteward(frame("steward.ask.result", { status: "answer", text: "当前 2 个实例运行中。" }));
    });
    await waitFor(() => {
      expect(screen.queryByTestId("steward-msg-streaming")).toBeNull();
      expect(screen.getByTestId("steward-msg-steward").textContent).toContain("实例运行中");
    });
  });
});
