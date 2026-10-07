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
const sendStewardHistory = vi.fn(() => true);
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
    sendStewardHistory,
    subscribeStewardFrames,
  }),
}));

import StewardPanel from "../ui/StewardPanel";

function frame(type: string, payload: unknown): EventEnvelope {
  return { v: "0.14", sessionId: "__system__", channel: "steward", type, payload } as EventEnvelope;
}

function renderPanel(onOpenMemory?: () => void) {
  return render(
    <I18nProvider>
      <StewardPanel onClose={() => undefined} {...(onOpenMemory !== undefined ? { onOpenMemory } : {})} />
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

  it("B2 键位照抄 Composer：Alt+Enter 发送；Enter 不拦截（原生换行零发送）", async () => {
    renderPanel();
    act(() => {
      emitSteward(frame("steward.config.result", { enabled: true, model: "x/y" }));
    });
    await waitFor(() => expect(screen.getByTestId("steward-input")).toBeTruthy());
    const ta = screen.getByTestId("steward-input") as HTMLTextAreaElement;
    // Enter：不拦截（换行语义——零发送，preventDefault 未调用）
    fireEvent.change(ta, { target: { value: "第一行" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(sendStewardAsk).not.toHaveBeenCalled();
    // Alt+Enter：发送（草稿清空）
    fireEvent.keyDown(ta, { key: "Enter", altKey: true });
    expect(sendStewardAsk).toHaveBeenCalledWith("第一行");
    await waitFor(() => expect((screen.getByTestId("steward-input") as HTMLTextAreaElement).value).toBe(""));
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

  it("B1：确认卡移出面板——confirm_required 到达面板零卡渲染（全局 ConfirmStack 承载）", async () => {
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
    // 面板不再承载卡（B1 移出——左下角全局卡栈）；确认/放弃按钮零发送
    await waitFor(() => expect(screen.queryByTestId("steward-confirm-card")).toBeNull());
    expect(sendStewardConfirm).not.toHaveBeenCalled();
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

// ══════════════════════════════════════════════════════════
// A1 工作记忆批：过程行 DOM 渲染（thinking 折叠 / 工具行 / 新对话钮）
// ══════════════════════════════════════════════════════════
describe("StewardPanel（A1 过程行渲染——真实 DOM 断言）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => cleanup());

  /** 渲染面板并喂 enabled 配置（挂载后 emit——订阅面就绪）。 */
  function renderEnabledPanel() {
    renderPanel();
    act(() => {
      emitSteward(frame("steward.config.result", { enabled: true, model: "deepseek/deepseek-v4-flash" }));
    });
  }

  it("【事故热修⑤】回放含 kind=compaction 记录 → 零渲染（压缩器输出不出现在对话流——不再伪装用户发言）", async () => {
    renderEnabledPanel();
    await waitFor(() => expect(screen.getByTestId("steward-input")).toBeTruthy());
    act(() => {
      emitSteward(
        frame("steward.history.result", {
          records: [
            { kind: "user", text: "在吗", at: 1 },
            { kind: "assistant", text: "在的", at: 2 },
            // 事故污染样本形态：压缩器格式文本——修复后以 kind=compaction 落库，
            // 回放零渲染（旧形态 kind=user + compaction:true 会渲染成用户气泡）
            {
              kind: "compaction",
              text: "## Goal\n（无。待压缩的对话为空，尚无用户任务或关注点。）\n\n## Constraints & Preferences\n- 压缩器工作规则：逐条保留",
              at: 3,
            } as never,
            { kind: "user", text: "继续", at: 4 },
          ],
        }),
      );
    });
    // 压缩器输出不在 DOM 任何位置（对话流零污染）
    expect(document.body.textContent ?? "").not.toContain("## Goal");
    expect(document.body.textContent ?? "").not.toContain("压缩器工作规则");
    // 真实对话轮照常渲染
    const userBubbles = screen.getAllByTestId("steward-msg-user");
    expect(userBubbles).toHaveLength(2); // 「在吗」「继续」（compaction 行不占位）
  });

  it("回放记录 → thinking 折叠条目默认收起，点击展开正文；工具行两态可展开结果摘要", async () => {
    renderEnabledPanel();
    await waitFor(() => expect(screen.getByTestId("steward-input")).toBeTruthy());
    act(() => {
      emitSteward(
        frame("steward.history.result", {
          records: [
            { kind: "user", text: "任务状态？", at: 1 },
            {
              kind: "assistant",
              thinking: { text: "先查任务清单再回答。", signature: "sig" },
              toolCall: { id: "call-0", name: "list_tasks", args: {} },
              at: 2,
            },
            { kind: "toolResult", toolCallId: "call-0", name: "list_tasks", text: "1 个任务运行中（50%）", at: 3 },
            { kind: "assistant", text: "1 个任务在跑。", at: 4 },
          ],
        }),
      );
    });
    // 气泡仍在（对话维持）
    expect(screen.getAllByTestId("steward-msg-user").length).toBe(1);
    expect(screen.getAllByTestId("steward-msg-steward").length).toBe(1);
    // thinking 折叠条目：默认收起（正文不在 DOM），展开后可见
    const thinkToggle = screen.getByTestId("steward-thinking-toggle");
    expect(screen.queryByTestId("steward-thinking-body")).toBeNull();
    fireEvent.click(thinkToggle);
    expect(screen.getByTestId("steward-thinking-body").textContent).toContain("先查任务清单再回答");
    fireEvent.click(screen.getByTestId("steward-thinking-toggle"));
    expect(screen.queryByTestId("steward-thinking-body")).toBeNull();
    // 工具行：完成态（✓）；展开可见结果摘要
    const toolState = screen.getByTestId("steward-tool-state");
    expect(toolState.textContent).toBe("✓");
    fireEvent.click(screen.getByTestId("steward-tool-toggle"));
    expect(screen.getByTestId("steward-tool-body").textContent).toContain("1 个任务运行中");
  });

  it("实时过程帧：thinking 段级与工具两相帧渲染（在途 … → 完成 ✓）", async () => {
    renderEnabledPanel();
    await waitFor(() => expect(screen.getByTestId("steward-input")).toBeTruthy());
    fireEvent.change(screen.getByTestId("steward-input"), { target: { value: "在跑什么？" } });
    fireEvent.click(screen.getByTestId("steward-send"));
    act(() => {
      emitSteward(frame("steward.thinking", { text: "需要先查实例清单。", seq: 1 }));
      emitSteward(frame("steward.tool", { phase: "start", name: "list_instances", argsSummary: "{}", seq: 2 }));
    });
    await waitFor(() => expect(screen.getByTestId("steward-thinking-item")).toBeTruthy());
    expect(screen.queryByTestId("steward-thinking-body")).toBeNull(); // 默认折叠
    await waitFor(() => expect(screen.getByTestId("steward-tool-item").textContent).toContain("list_instances"));
    expect(screen.getByTestId("steward-tool-state").textContent).toBe("…"); // 在途
    act(() => {
      emitSteward(frame("steward.tool", { phase: "end", name: "list_instances", resultSummary: "2 条记录", seq: 3 }));
    });
    await waitFor(() => expect(screen.getByTestId("steward-tool-state").textContent).toBe("✓"));
  });

  it("新对话按钮：点击 → sendStewardHistory(true) + 本地条目清空", async () => {
    renderEnabledPanel();
    await waitFor(() => expect(screen.getByTestId("steward-input")).toBeTruthy());
    fireEvent.change(screen.getByTestId("steward-input"), { target: { value: "第一问" } });
    fireEvent.click(screen.getByTestId("steward-send"));
    await waitFor(() => expect(screen.getAllByTestId("steward-msg-user").length).toBe(1));
    fireEvent.click(screen.getByTestId("steward-new-chat"));
    expect(sendStewardHistory).toHaveBeenCalledWith(true);
    await waitFor(() => expect(screen.queryAllByTestId("steward-msg-user").length).toBe(0));
  });
});

// ── 管家记忆 B2-④：头部记忆入口钮（入口①→ /steward/memory）──

describe("StewardPanel 记忆入口钮（B2-④ 入口①）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => cleanup());
  localStorage.setItem("helix-lang", "zh-CN");

  it("头部渲染记忆钮（data-testid=steward-open-memory）；点击 → onOpenMemory 回调", async () => {
    const onOpenMemory = vi.fn();
    const { findByTestId } = renderPanel(onOpenMemory);
    // config.result enabled 后面板激活（头部含记忆钮）
    await act(async () => {
      emitSteward(
        frame("steward.config.result", {
          enabled: true,
          model: "deepseek/x",
          memory: { enabled: false, available: false, endpoint: null, entryCount: 0, dim: null },
        }),
      );
    });
    const btn = await findByTestId("steward-open-memory");
    fireEvent.click(btn);
    expect(onOpenMemory).toHaveBeenCalledTimes(1);
  });

  it("未注入 onOpenMemory（可选位）：钮渲染不炸、点击零动作", async () => {
    const { findByTestId } = renderPanel();
    await act(async () => {
      emitSteward(
        frame("steward.config.result", {
          enabled: true,
          model: "deepseek/x",
          memory: { enabled: false, available: false, endpoint: null, entryCount: 0, dim: null },
        }),
      );
    });
    const btn = await findByTestId("steward-open-memory");
    expect(() => fireEvent.click(btn)).not.toThrow();
  });
});

// ══════════════════════════════════════════════════════════
// 过程反馈 UI 批（问题 9）：ask 进行中固定两行滚动状态区 +
// 工具行耗时计时（fake timer 断言启表/滚动/定格）
// ══════════════════════════════════════════════════════════
describe("StewardPanel（过程反馈——状态区与工具计时）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  function renderEnabledPanel() {
    renderPanel();
    act(() => {
      emitSteward(frame("steward.config.result", { enabled: true, model: "deepseek/x" }));
    });
  }

  async function askInFlight() {
    await waitFor(() => expect(screen.getByTestId("steward-input")).toBeTruthy());
    fireEvent.change(screen.getByTestId("steward-input"), { target: { value: "在跑什么？" } });
    fireEvent.click(screen.getByTestId("steward-send"));
    await waitFor(() => expect(screen.getByTestId("steward-inflight")).toBeTruthy());
  }

  it("ask 进行中：状态区可见（状态文思考中）；收口后状态区收起", async () => {
    renderEnabledPanel();
    await askInFlight();
    expect(screen.getByTestId("steward-inflight-status").textContent).toContain("思考中");
    act(() => {
      emitSteward(frame("steward.ask.result", { status: "answer", text: "2 个实例运行中。" }));
    });
    await waitFor(() => expect(screen.queryByTestId("steward-inflight")).toBeNull());
  });

  it("thinking 段级帧 → 滚动区追加首行摘要；第 3 块到达第 1 块滚出（两行窗）", async () => {
    renderEnabledPanel();
    await askInFlight();
    act(() => {
      emitSteward(frame("steward.thinking", { text: "块一：先查清单。\n正文次行不进摘要", seq: 1 }));
      emitSteward(frame("steward.thinking", { text: "块二：对比实例。", seq: 2 }));
    });
    await waitFor(() => expect(screen.getAllByTestId("steward-inflight-think-line").length).toBe(2));
    expect(screen.getByTestId("steward-inflight-think").textContent).toContain("先查清单");
    expect(screen.getByTestId("steward-inflight-think").textContent).not.toContain("正文次行");
    act(() => {
      emitSteward(frame("steward.thinking", { text: "块三：组织结论。", seq: 3 }));
    });
    await waitFor(() => expect(screen.getAllByTestId("steward-inflight-think-line").length).toBe(2));
    expect(screen.getByTestId("steward-inflight-think").textContent).not.toContain("先查清单");
    expect(screen.getByTestId("steward-inflight-think").textContent).toContain("组织结论");
  });

  it("工具运行期状态文切「正在调用」；工具行显示名字与实时耗时（fake timer 随时间更新）", async () => {
    renderEnabledPanel();
    await askInFlight();
    // 在真实时钟下完成 render/ask 就绪后再冻结时钟（waitFor 依赖真实 timer）
    vi.useFakeTimers();
    act(() => {
      emitSteward(frame("steward.tool", { phase: "start", name: "list_instances", argsSummary: "{}", seq: 1 }));
    });
    // 状态文动态：思考中 → 正在调用（工具名可见）
    expect(screen.getByTestId("steward-inflight-status").textContent).toContain("正在调用");
    expect(screen.getByTestId("steward-inflight-status").textContent).toContain("list_instances");
    // 工具行：名字 + 计时启表随时间滚动
    expect(screen.getByTestId("steward-tool-item").textContent).toContain("list_instances");
    expect(screen.getByTestId("steward-tool-elapsed").textContent).toBe("0.0s");
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByTestId("steward-tool-elapsed").textContent).toBe("3.0s");
  });

  it("toolResult 到达 → 计时定格（后续推进零变化）", async () => {
    renderEnabledPanel();
    await askInFlight();
    vi.useFakeTimers();
    act(() => {
      emitSteward(frame("steward.tool", { phase: "start", name: "list_tasks", argsSummary: "{}", seq: 1 }));
    });
    act(() => {
      vi.advanceTimersByTime(5000);
      emitSteward(frame("steward.tool", { phase: "end", name: "list_tasks", resultSummary: "1 个任务", seq: 2 }));
    });
    expect(screen.getByTestId("steward-tool-elapsed").textContent).toBe("5.0s");
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(screen.getByTestId("steward-tool-elapsed").textContent).toBe("5.0s"); // 定格
    expect(screen.getByTestId("steward-tool-state").textContent).toBe("✓"); // 两态不回退
  });

  it("回放工具行（无耗时锦）不显示计时", async () => {
    renderEnabledPanel();
    await waitFor(() => expect(screen.getByTestId("steward-input")).toBeTruthy());
    act(() => {
      emitSteward(
        frame("steward.history.result", {
          records: [
            { kind: "user", text: "任务状态？", at: 1 },
            { kind: "assistant", toolCall: { id: "call-0", name: "list_tasks", args: {} }, at: 2 },
            { kind: "toolResult", toolCallId: "call-0", name: "list_tasks", text: "1 个任务", at: 3 },
          ],
        }),
      );
    });
    await waitFor(() => expect(screen.getByTestId("steward-tool-item").textContent).toContain("list_tasks"));
    expect(screen.queryByTestId("steward-tool-elapsed")).toBeNull();
  });
});
