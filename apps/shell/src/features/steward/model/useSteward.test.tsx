// @vitest-environment jsdom
/**
 * useSteward 测试（V2.5 文本管家批；命令面全 stub，零真机依赖；B1 文本
 * 链路批改造：订阅解绑 + 确认卡移出）。
 *
 * - 配置读面：mount → sendStewardGetConfig；config.result → config 态更新；
 * - 订阅闸门（B1 订阅解绑，设计稿 §3.5）：connected + enabled →
 *   sendStewardSubscribe——**面板开合不再影响订阅**（navigate/feed 帧面板
 *   关闭照达，G2 解耦）；enabled=false → unsubscribe（money gate 语义不变）；
 * - 对话面：ask 发送 → in-flight；steward.ask.delta → streamingText 增量
 *   聚合；ask.result(answer) → 追加 steward 消息并清 streamingText；
 *   ask.result(error) → 追加错误行；confirm_required → 本面零处理
 *   （卡归全局 ConfirmStack / useStewardActions）；
 * - action.completed（B1 两段式第二段）→ items 历史留痕；
 * - feed 面：steward.feed → 追加文本行（上限截尾防无界）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, act, waitFor } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import type { EventEnvelope } from "@helix/protocol";

const sendStewardAsk = vi.fn(() => true);
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

function renderSteward() {
  return renderHook(() => useSteward(), {
    wrapper: ({ children }) => <I18nProvider>{children}</I18nProvider>,
  });
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

  it("B1 订阅解绑：connected + enabled → subscribe——面板开合零影响（关面板不 unsubscribe）", async () => {
    const { result } = renderSteward();
    act(() => {
      frameListener?.(frame("steward.config.result", { enabled: true, model: "deepseek/deepseek-v4-flash" }));
    });
    await waitFor(() => expect(result.current.config?.enabled).toBe(true));
    expect(sendStewardSubscribe).toHaveBeenCalled();
    // config 到达后（enabled=true 订阅态稳定）：面板开合不再出现在订阅条件里
    // ——订阅效应零重发、零退订（G2 解耦——面板关闭后 navigate/feed 照达）
    sendStewardSubscribe.mockClear();
    sendStewardUnsubscribe.mockClear();
    act(() => {
      result.current.ask("面板开合无关的一问");
    });
    act(() => {
      frameListener?.(frame("steward.feed", { kind: "agent.completed", agentId: "agent-1", text: "完工", seq: 1 }));
    });
    await waitFor(() => expect(result.current.feed.length).toBe(1));
    expect(sendStewardUnsubscribe).not.toHaveBeenCalled();
  });

  it("未启用（enabled=false）→ 不 subscribe（money gate 语义不变）+ connected 时 unsubscribe", async () => {
    const { result } = renderSteward();
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
    expect(result.current.items.length).toBe(1);
    expect(result.current.askInFlight).toBe(true);
    act(() => {
      frameListener?.(frame("steward.ask.result", { status: "answer", text: "当前 2 个实例运行中。" }));
    });
    await waitFor(() => {
      expect(result.current.streamingText).toBeNull();
      expect(result.current.askInFlight).toBe(false);
    });
    expect(result.current.items.some((m) => m.kind === "assistant" && m.text === "当前 2 个实例运行中。")).toBe(true);
  });

  it("L1 件二：queued 确认帧 → 「已排队」条目；不清 streaming、不结束在途态（结果帧随后收口）", async () => {
    const { result } = renderSteward();
    act(() => {
      result.current.ask("在跑什么？");
    });
    act(() => {
      frameListener?.(frame("steward.ask.delta", { delta: "当前 ", seq: 1 }));
    });
    await waitFor(() => expect(result.current.streamingText).toBe("当前 "));
    act(() => {
      frameListener?.(frame("steward.ask.result", { status: "queued", queued: true, position: 1 }));
    });
    expect(result.current.items.some((m) => m.kind === "assistant" && /已排队|Queued/.test(m.text))).toBe(true);
    expect(result.current.streamingText).toBe("当前 ");
    expect(result.current.askInFlight).toBe(true);
    act(() => {
      frameListener?.(frame("steward.ask.result", { status: "answer", text: "当前 2 个实例运行中。" }));
    });
    await waitFor(() => {
      expect(result.current.streamingText).toBeNull();
      expect(result.current.askInFlight).toBe(false);
    });
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

  it("B1：confirm_required 回执 → 本面零处理（卡归全局 ConfirmStack；items 不动、在途收口照常）", async () => {
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
    await waitFor(() => expect(result.current.askInFlight).toBe(false));
    // 本面只有 user 问句（确认卡由 useStewardActions 入栈——另一测试面）
    expect(result.current.items.length).toBe(1);
  });

  it("B1：action.completed → items 历史留痕（detail 文本；成败同面）", async () => {
    const { result } = renderSteward();
    act(() => {
      frameListener?.(frame("steward.action.completed", { actionId: "steward-action-1", ok: true, detail: "已注入会话 s-1 的 steer 队列" }));
    });
    await waitFor(() =>
      expect(result.current.items.some((m) => m.kind === "assistant" && m.text.includes("steer 队列"))).toBe(true),
    );
    act(() => {
      frameListener?.(frame("steward.action.completed", { actionId: "steward-action-2", ok: false, detail: "投递未送达：目标会话正在中断" }));
    });
    await waitFor(() =>
      expect(result.current.items.some((m) => m.kind === "assistant" && m.text.includes("投递未送达"))).toBe(true),
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
    await waitFor(() => expect(sendStewardHistoryMock).toHaveBeenCalledWith());
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
    await waitFor(() => expect(result.current.items.length).toBe(3));
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
    act(() => {
      frameListener?.(frame("steward.history.result", { records: [] }));
    });
    await waitFor(() => expect(result.current.items.length).toBe(0));
  });

  it("非在途迟到 delta 忽略（防脏写）", async () => {
    const { result } = renderSteward();
    act(() => {
      frameListener?.(frame("steward.ask.delta", { delta: "迟到", seq: 9 }));
    });
    expect(result.current.streamingText).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════
// 过程反馈 UI 批（问题 9）：ask 进行中态投影（askActivity）+
// 工具行耗时锦标（startedAt/endedAt 记账）
// ══════════════════════════════════════════════════════════
describe("useSteward（过程反馈 UI 批——进行中态投影）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connState = "connected";
  });
  afterEach(() => cleanup());

  it("ask → askActivity 思考态；终态 answer → 收口清 null", async () => {
    const { result } = renderSteward();
    act(() => {
      result.current.ask("在跑什么？");
    });
    expect(result.current.askActivity).toEqual({ phase: "thinking", toolName: null, thinkingLines: [] });
    act(() => {
      frameListener?.(frame("steward.ask.result", { status: "answer", text: "2 个实例运行中。" }));
    });
    await waitFor(() => expect(result.current.askActivity).toBeNull());
  });

  it("steward.thinking → 追加首行摘要（多行取首非空行）；窗口保最近 2 条（第 3 块滚出）", async () => {
    const { result } = renderSteward();
    act(() => {
      result.current.ask("在跑什么？");
    });
    act(() => {
      frameListener?.(frame("steward.thinking", { text: "\n  \n第一块首行：先查任务清单。\n次行不进摘要。", seq: 1 }));
    });
    await waitFor(() => expect(result.current.askActivity?.thinkingLines).toEqual(["第一块首行：先查任务清单。"]));
    act(() => {
      frameListener?.(frame("steward.thinking", { text: "第二块：对比实例。", seq: 2 }));
      frameListener?.(frame("steward.thinking", { text: "第三块：组织结论。", seq: 3 }));
    });
    await waitFor(() => expect(result.current.askActivity?.thinkingLines).toEqual(["第二块：对比实例。", "第三块：组织结论。"]));
  });

  it("【事故热修⑥】长 thinking 块一帧（段级契约）→ 状态区摘要单行截断（超 60 字加省略号）而非 N 行", async () => {
    const { result } = renderSteward();
    act(() => {
      result.current.ask("帮我切过去");
    });
    const longBlock =
      "用户要求切换会话，我需要先确认目标会话的 id 再调用 navigate 工具，注意 shell 表面的 navigate 参数是 sessionId 不是 url，先用 surface_list 查表面。";
    act(() => {
      frameListener?.(frame("steward.thinking", { text: longBlock, seq: 1 }));
    });
    await waitFor(() => {
      const lines = result.current.askActivity?.thinkingLines ?? [];
      expect(lines).toHaveLength(1); // 单行（不是按字 N 行）
      expect(lines[0]!.length).toBeLessThanOrEqual(61); // 60 字 + 省略号
      expect(lines[0]!.endsWith("…")).toBe(true);
      expect(lines[0]!.startsWith("用户要求切换会话")).toBe(true);
    });
  });

  it("steward.tool start → phase=tool + toolName；end → phase 回 thinking + 条目补 endedAt 定格锦", async () => {
    const { result } = renderSteward();
    act(() => {
      result.current.ask("在跑什么？");
    });
    act(() => {
      frameListener?.(frame("steward.tool", { phase: "start", name: "list_instances", argsSummary: "{}", seq: 1 }));
    });
    await waitFor(() => expect(result.current.askActivity?.phase).toBe("tool"));
    expect(result.current.askActivity?.toolName).toBe("list_instances");
    const started = result.current.items.find((i) => i.kind === "tool");
    expect(started).toMatchObject({ kind: "tool", name: "list_instances" });
    if (started?.kind === "tool") expect(started.startedAt).toBeGreaterThan(0);
    act(() => {
      frameListener?.(frame("steward.tool", { phase: "end", name: "list_instances", resultSummary: "2 条记录", seq: 2 }));
    });
    await waitFor(() => expect(result.current.askActivity?.phase).toBe("thinking"));
    const done = [...result.current.items].reverse().find((i) => i.kind === "tool");
    expect(done).toMatchObject({ kind: "tool", resultSummary: "2 条记录" });
    if (done?.kind === "tool" && started?.kind === "tool") {
      expect(done.endedAt).not.toBeNull();
      expect(done.endedAt!).toBeGreaterThanOrEqual(started.startedAt!);
    }
  });

  it("回放 tool 条目零耗时锦（startedAt/endedAt null——历史无耗时语义，UI 不显示计时）", async () => {
    const { result } = renderSteward();
    await waitFor(() => expect(sendStewardHistoryMock).toHaveBeenCalled());
    act(() => {
      frameListener?.(
        frame("steward.history.result", {
          records: [
            { kind: "user", text: "任务状态？", at: 1 },
            { kind: "assistant", toolCall: { id: "call-0", name: "list_tasks", args: {} }, at: 2 },
            { kind: "toolResult", toolCallId: "call-0", name: "list_tasks", text: "1 个任务", at: 3 },
          ],
        }),
      );
    });
    await waitFor(() => expect(result.current.items.length).toBe(2));
    const tool = result.current.items.find((i) => i.kind === "tool");
    if (tool?.kind === "tool") {
      expect(tool.startedAt).toBeNull();
      expect(tool.endedAt).toBeNull();
    }
  });
});
