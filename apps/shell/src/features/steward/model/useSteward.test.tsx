// @vitest-environment jsdom
/**
 * useSteward 测试（V2.5 文本管家批；命令面全 stub，零真机依赖）。
 *
 * - 配置读面：mount → sendStewardGetConfig；config.result → config 态更新；
 * - 订阅闸门：面板开 + conn=connected + enabled → sendStewardSubscribe；
 *   面板关/未启用 → sendStewardUnsubscribe（连接级闸门对齐 daemon money gate）；
 * - 对话面：ask 发送 → in-flight；steward.ask.delta → streamingText 增量
 *   聚合（流式不落盘——items 不追加，V2.5 体验批）；ask.result(answer) →
 *   追加 steward 消息并清 streamingText（终态权威覆盖）；
 *   ask.result(confirm_required) → pending 态携带 actionId/agentId/message；
 *   ask.result(error) → 追加错误行；
 * - 确认闸：sendStewardConfirm(actionId)；confirm.result(ok) → 清 pending +
 *   追加投递回执行；confirm.result(error) → 追加错误行；
 * - feed 面：steward.feed → 追加文本行（上限截尾防无界）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, act, waitFor } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import type { EventEnvelope } from "@helix/protocol";

const sendStewardAsk = vi.fn(() => true);
const sendStewardConfirm = vi.fn(() => true);
const sendStewardSubscribe = vi.fn(() => true);
const sendStewardUnsubscribe = vi.fn(() => true);
const sendStewardGetConfig = vi.fn(() => true);
const sendStewardSetConfig = vi.fn(() => true);
const sendStewardHistoryMock = vi.fn(() => true);
let frameListener: ((e: EventEnvelope) => void) | null = null;
const subscribeStewardFrames = vi.fn((cb: (e: EventEnvelope) => void) => {
  frameListener = cb;
  return () => {
    frameListener = null;
  };
});
let connState = "connected";

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    topology: { active: { conn: connState } },
    sendStewardAsk,
    sendStewardConfirm,
    sendStewardSubscribe,
    sendStewardUnsubscribe,
    sendStewardGetConfig,
    sendStewardSetConfig,
    sendStewardHistory: sendStewardHistoryMock,
    subscribeStewardFrames,
  }),
}));

import { useSteward, STEWARD_FEED_MAX_LINES } from "./useSteward";

function frame(type: string, payload: unknown): EventEnvelope {
  return { v: "0.14", sessionId: "__system__", channel: "steward", type, payload } as EventEnvelope;
}

function renderSteward(opts?: { open?: boolean }) {
  const initial = { open: opts?.open ?? true };
  const rendered = renderHook(({ open }) => useSteward(open), {
    initialProps: initial,
    wrapper: ({ children }) => <I18nProvider>{children}</I18nProvider>,
  });
  return rendered;
}

describe("useSteward（V2.5 文本管家）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connState = "connected";
  });
  afterEach(() => cleanup());

  it("mount → sendStewardGetConfig；config.result 更新 config 态", async () => {
    const { result } = renderSteward();
    expect(sendStewardGetConfig).toHaveBeenCalled();
    act(() => {
      frameListener?.(frame("steward.config.result", { enabled: true, model: "deepseek/deepseek-v4-flash" }));
    });
    await waitFor(() => {
      expect(result.current.config).toEqual({ enabled: true, model: "deepseek/deepseek-v4-flash" });
    });
  });

  it("面板开 + connected → subscribe；面板关 → unsubscribe", async () => {
    // 先喂 enabled 配置
    const { result, rerender } = renderSteward({ open: true });
    act(() => {
      frameListener?.(frame("steward.config.result", { enabled: true, model: "deepseek/deepseek-v4-flash" }));
    });
    await waitFor(() => expect(result.current.config?.enabled).toBe(true));
    expect(sendStewardSubscribe).toHaveBeenCalled();
    rerender({ open: false });
    await waitFor(() => expect(sendStewardUnsubscribe).toHaveBeenCalled());
  });

  it("未启用（enabled=false）→ 不 subscribe", async () => {
    const { result } = renderSteward({ open: true });
    act(() => {
      frameListener?.(frame("steward.config.result", { enabled: false, model: "x/y" }));
    });
    await waitFor(() => expect(result.current.config?.enabled).toBe(false));
    expect(sendStewardSubscribe).not.toHaveBeenCalled();
  });

  it("ask → in-flight；answer 回执 → 追加 steward 消息并清 in-flight", async () => {
    const { result } = renderSteward();
    act(() => {
      result.current.ask("现在有什么在跑？");
    });
    expect(sendStewardAsk).toHaveBeenCalledWith("现在有什么在跑？");
    expect(result.current.askInFlight).toBe(true);
    act(() => {
      frameListener?.(frame("steward.ask.result", { status: "answer", text: "2 个实例运行中。" }));
    });
    await waitFor(() => expect(result.current.askInFlight).toBe(false));
    expect(result.current.items.some((m) => m.kind === "user" && m.text.includes("在跑"))).toBe(true);
    expect(result.current.items.some((m) => m.kind === "assistant" && m.text.includes("实例"))).toBe(true);
  });

  it("流式：多 delta → streamingText 增量累积（messages 不追加）；result → 清空并落权威消息（V2.5 体验批）", async () => {
    const { result } = renderSteward();
    act(() => {
      result.current.ask("在跑什么？");
    });
    act(() => {
      frameListener?.(frame("steward.ask.delta", { delta: "当前 ", seq: 1 }));
      frameListener?.(frame("steward.ask.delta", { delta: "**2 个**", seq: 2 }));
      frameListener?.(frame("steward.ask.delta", { delta: "实例", seq: 3 }));
    });
    await waitFor(() => expect(result.current.streamingText).toBe("当前 **2 个**实例"));
    // 流式不落盘：items 不追加（在途条目只有 user 问句）
    expect(result.current.items.length).toBe(1);
    expect(result.current.askInFlight).toBe(true); // 终态未到仍在途
    act(() => {
      frameListener?.(frame("steward.ask.result", { status: "answer", text: "当前 2 个实例运行中。" }));
    });
    await waitFor(() => {
      expect(result.current.streamingText).toBeNull(); // 终态清缓冲
      expect(result.current.askInFlight).toBe(false);
    });
    // 权威文本覆盖（result.text，非 delta 拼接）
    expect(result.current.items.some((m) => m.kind === "assistant" && m.text === "当前 2 个实例运行中。")).toBe(true);
  });

  it("流式：error 终态同样清 streamingText（中途失败零残留）", async () => {
    const { result } = renderSteward();
    act(() => {
      result.current.ask("在跑什么？");
    });
    act(() => {
      frameListener?.(frame("steward.ask.delta", { delta: "部分输出", seq: 1 }));
    });
    await waitFor(() => expect(result.current.streamingText).toBe("部分输出"));
    act(() => {
      frameListener?.(frame("steward.ask.result", { status: "error", reason: "模型调用失败" }));
    });
    await waitFor(() => {
      expect(result.current.streamingText).toBeNull();
      expect(result.current.askInFlight).toBe(false);
    });
    expect(result.current.items.some((m) => m.kind === "assistant" && m.text.includes("模型调用失败"))).toBe(true);
  });

  it("confirm_required 回执 → pending 携带 actionId/agentId/message", async () => {
    const { result } = renderSteward();
    act(() => {
      result.current.ask("让 agent-1 跑 lint");
    });
    act(() => {
      frameListener?.(
        frame("steward.ask.result", {
          status: "confirm_required",
          actionId: "steward-action-1",
          agentId: "agent-1",
          message: "顺带跑一下 lint",
        }),
      );
    });
    await waitFor(() => expect(result.current.pending).toEqual({
      actionId: "steward-action-1",
      agentId: "agent-1",
      message: "顺带跑一下 lint",
    }));
    // 未确认零执行：confirm 命令未发
    expect(sendStewardConfirm).not.toHaveBeenCalled();
  });

  it("确认按钮 → sendStewardConfirm；ok 回执 → 清 pending + 追加回执行", async () => {
    const { result } = renderSteward();
    act(() => {
      frameListener?.(
        frame("steward.ask.result", {
          status: "confirm_required",
          actionId: "steward-action-2",
          agentId: "agent-1",
          message: "hi",
        }),
      );
    });
    await waitFor(() => expect(result.current.pending).not.toBeNull());
    act(() => {
      result.current.confirmPending();
    });
    expect(sendStewardConfirm).toHaveBeenCalledWith("steward-action-2");
    act(() => {
      frameListener?.(
        frame("steward.confirm.result", { status: "ok", agentId: "agent-1", detail: "已投递（turn 边界注入生效）" }),
      );
    });
    await waitFor(() => expect(result.current.pending).toBeNull());
    expect(result.current.items.some((m) => m.kind === "assistant" && m.text.includes("已投递"))).toBe(true);
  });

  it("confirm error 回执 → 追加错误行", async () => {
    const { result } = renderSteward();
    act(() => {
      frameListener?.(
        frame("steward.ask.result", {
          status: "confirm_required",
          actionId: "steward-action-3",
          agentId: "agent-1",
          message: "hi",
        }),
      );
    });
    await waitFor(() => expect(result.current.pending).not.toBeNull());
    act(() => {
      result.current.confirmPending();
    });
    act(() => {
      frameListener?.(frame("steward.confirm.result", { status: "error", reason: "动作已消费" }));
    });
    await waitFor(() =>
      expect(result.current.items.some((m) => m.kind === "assistant" && m.text.includes("已消费"))).toBe(true),
    );
  });

  it("ask error 回执（开关关等）→ 追加错误行并清 in-flight", async () => {
    const { result } = renderSteward();
    act(() => {
      result.current.ask("在跑什么？");
    });
    act(() => {
      frameListener?.(frame("steward.ask.result", { status: "error", reason: "管家未开启" }));
    });
    await waitFor(() => expect(result.current.askInFlight).toBe(false));
    expect(result.current.items.some((m) => m.kind === "assistant" && m.text.includes("未开启"))).toBe(true);
  });

  it("feed 文本行追加；超上限截尾（保最新）", async () => {
    const { result } = renderSteward();
    for (let i = 1; i <= STEWARD_FEED_MAX_LINES + 10; i += 1) {
      act(() => {
        frameListener?.(frame("steward.feed", { kind: "agent.completed", agentId: `agent-${i}`, text: `第 ${i} 行`, seq: i }));
      });
    }
    expect(result.current.feed.length).toBe(STEWARD_FEED_MAX_LINES);
    expect(result.current.feed[result.current.feed.length - 1]!.text).toContain(`第 ${STEWARD_FEED_MAX_LINES + 10} 行`);
  });
});

// ══════════════════════════════════════════════════════════
// A1 工作记忆批：回放同源 / 过程帧 / 新对话三清
// ══════════════════════════════════════════════════════════
describe("useSteward（A1 工作记忆）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connState = "connected";
  });
  afterEach(() => cleanup());

  it("mount + connected → sendStewardHistory()（回放拉取；同连接幂等）", async () => {
    const { result } = renderSteward();
    await waitFor(() => expect(sendStewardHistoryMock).toHaveBeenCalledWith()); // 回放读面（无参 = clear 缺省 false）
    expect(sendStewardHistoryMock).toHaveBeenCalledTimes(1);
    void result.current;
  });

  it("history.result → items 同源重建（user/assistant/thinking/tool 全形态 + toolResult 配对回填）", async () => {
    const { result } = renderSteward();
    await waitFor(() => expect(sendStewardHistoryMock).toHaveBeenCalled());
    act(() => {
      frameListener?.(
        frame("steward.history.result", {
          records: [
            { kind: "user", text: "任务状态？", at: 1 },
            {
              kind: "assistant",
              thinking: { text: "先查任务清单。", signature: "sig-a" },
              toolCall: { id: "call-0", name: "list_tasks", args: {} },
              at: 2,
            },
            { kind: "toolResult", toolCallId: "call-0", name: "list_tasks", text: "[{\"jobId\":\"job-1\"}]", at: 3 },
            { kind: "assistant", text: "1 个任务在跑。", at: 4 },
          ],
        }),
      );
    });
    await waitFor(() => expect(result.current.items.length).toBe(4));
    expect(result.current.items[0]).toEqual({ kind: "user", text: "任务状态？" });
    expect(result.current.items[1]).toEqual({ kind: "thinking", text: "先查任务清单。" });
    // 工具行：toolResult 已配对回填结果摘要
    expect(result.current.items[2]).toMatchObject({ kind: "tool", name: "list_tasks", resultSummary: expect.stringContaining("job-1") });
    expect(result.current.items[3]).toEqual({ kind: "assistant", text: "1 个任务在跑。" });
  });

  it("实时过程帧：steward.thinking → thinking 条目；steward.tool start/end → 工具行两态", async () => {
    const { result } = renderSteward();
    act(() => {
      result.current.ask("在跑什么？");
    });
    act(() => {
      frameListener?.(frame("steward.thinking", { text: "需要先查实例。", seq: 1 }));
      frameListener?.(frame("steward.tool", { phase: "start", name: "list_instances", argsSummary: "{}", seq: 2 }));
    });
    await waitFor(() => expect(result.current.items.length).toBe(3)); // user + thinking + tool(pending)
    expect(result.current.items[1]).toEqual({ kind: "thinking", text: "需要先查实例。" });
    expect(result.current.items[2]).toMatchObject({ kind: "tool", name: "list_instances", resultSummary: null });
    act(() => {
      frameListener?.(frame("steward.tool", { phase: "end", name: "list_instances", resultSummary: "2 条记录", seq: 3 }));
    });
    await waitFor(() => {
      const tool = result.current.items[2];
      expect(tool).toMatchObject({ kind: "tool", resultSummary: "2 条记录" });
    });
  });

  it("新对话：newDialog() → sendStewardHistory(true) + 本地 items 清空；回执空数组幂等", async () => {
    const { result } = renderSteward();
    act(() => {
      result.current.ask("第一问");
    });
    await waitFor(() => expect(result.current.items.length).toBe(1));
    act(() => {
      result.current.newDialog();
    });
    expect(sendStewardHistoryMock).toHaveBeenCalledWith(true);
    await waitFor(() => expect(result.current.items.length).toBe(0));
    // 回执（空数组）到达——幂等覆盖仍为空
    act(() => {
      frameListener?.(frame("steward.history.result", { records: [] }));
    });
    await waitFor(() => expect(result.current.items.length).toBe(0));
  });

  it("非在途迟到 delta 忽略（防脏写）——thinking/tool 帧在非 ask 期仍可入列（回放后到达的独立事件）", async () => {
    const { result } = renderSteward();
    act(() => {
      frameListener?.(frame("steward.ask.delta", { delta: "迟到", seq: 9 }));
    });
    expect(result.current.streamingText).toBeNull(); // 非在途零聚合
  });
});
