// @vitest-environment jsdom
/**
 * MessageFlow 挂载测试（thinking 三态分流；消费 T4.1 槽位）。
 *
 * 自 ThinkingBlock.test.tsx 拆出（T4.3：ThinkingBlock 上移 shared/ui 后，
 * MessageFlow 集成断言按 FSD 分层归位 widgets/chat-stream）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import type { EventEnvelope, ThinkingEntryDto } from "@helix/protocol";
import { createInitialSessionState, sessionReducer, type SessionState } from "@/entities/session/model/session-reducer";

// ── SessionContext mock（state 注入；selectIsEmpty 等保持真体）──
const stateRef: { current: SessionState } = { current: createInitialSessionState() };
/** loadEarlierHistory 探针（H-2：滚动触发退役 / 按钮唯一触发面断言）。 */
const loadEarlierSpy = vi.fn();
vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({ state: stateRef.current, loadEarlierHistory: loadEarlierSpy }),
  };
});

import MessageFlow from "./MessageFlow";

function ui(node: React.ReactElement) {
  return render(<I18nProvider>{node}</I18nProvider>);
}

function thinkEntry(over: Partial<ThinkingEntryDto> = {}): ThinkingEntryDto {
  return {
    kind: "thinking",
    id: "think-1",
    instanceId: "main",
    text: "盘点当前态：并发预算 3，前三个立即执行，依赖扫描进 FIFO 队列。",
    durationMs: 12_400,
    reasoningTokens: 847,
    createdAt: "2026-08-16T14:02:00+08:00",
    ...over,
  };
}

afterEach(cleanup);

// jsdom navigator.language 默认 en-US：钉 zh-CN（产品断言语言，AG-14 白名单键）
localStorage.setItem("helix-lang", "zh-CN");

/**
 * 消息流 SubAgent 卡片时间轴内联（T5.5；task brief §4.2）：卡片按 spawn 锚点
 * 交织进 entries 序列原位渲染（替代末尾 .sa-cards 汇聚块）；状态原位更新、
 * 终态留原位；同锚点多卡保 spawn 先后序。
 */
describe("MessageFlow SubAgent 卡片时间轴内联（T5.5）", () => {
  const welcome: EventEnvelope = {
    v: 0,
    type: "connection.welcome",
    payload: { sessionId: "s1", model: "claude-sonnet-4-5", agentState: "idle" },
  };
  const completedMsg = (id: string): EventEnvelope => ({
    v: 0,
    type: "chat.message.completed",
    payload: { entry: { kind: "message", id, role: "assistant", content: `text-${id}`, ts: 1 } },
  });
  const spawn = (agentId: string, anchorEntryId: string | null): EventEnvelope => ({
    v: 0,
    type: "agent.spawned",
    payload: { agentId, task: `task-${agentId}`, profileKind: "subagent-worker", anchorEntryId },
  });
  const play = (events: EventEnvelope[]): SessionState =>
    events.reduce((s, e) => sessionReducer(s, { type: "event", event: e }), createInitialSessionState());

  /** .session-active 内目标元素的文档序（entries 与卡片交织断言） */
  const orderOf = (el: Element): number => {
    const kids = Array.from(document.querySelector(".session-active")!.children);
    return kids.findIndex((k) => k === el || k.contains(el));
  };
  const entryEl = (id: string) => screen.getByText(`text-${id}`).closest(".msg")!;
  const cardEl = (id: string) => document.querySelector(`.sa-card[data-instance="${id}"]`)!;

  it("卡片按 spawn 锚点交织进 entries 序列（m1 → 卡 → m2）", () => {
    stateRef.current = play([welcome, completedMsg("m1"), spawn("a1", "m1"), completedMsg("m2")]);
    ui(<MessageFlow />);
    expect(orderOf(entryEl("m1"))).toBeLessThan(orderOf(cardEl("a1")));
    expect(orderOf(cardEl("a1"))).toBeLessThan(orderOf(entryEl("m2")));
  });

  it("状态原位更新：running→done 终态卡留原位", () => {
    stateRef.current = play([
      welcome,
      completedMsg("m1"),
      spawn("a1", "m1"),
      completedMsg("m2"),
      {
        v: 0,
        type: "agent.completed",
        payload: { agentId: "a1", closure: { status: "done", summary: "收口" } },
      } as EventEnvelope,
    ]);
    ui(<MessageFlow />);
    const card = cardEl("a1");
    expect(card.classList.contains("done")).toBe(true);
    expect(orderOf(entryEl("m1"))).toBeLessThan(orderOf(card));
    expect(orderOf(card)).toBeLessThan(orderOf(entryEl("m2")));
  });

  it("末尾 .sa-cards 汇聚块已移除", () => {
    stateRef.current = play([welcome, completedMsg("m1"), spawn("a1", "m1")]);
    ui(<MessageFlow />);
    expect(document.querySelector(".sa-cards")).toBeNull();
  });

  it("无 entries 时 spawn 卡片渲染在后续 entries 之前（流首锚点）", () => {
    stateRef.current = play([welcome, spawn("a1", null), completedMsg("m1")]);
    ui(<MessageFlow />);
    expect(orderOf(cardEl("a1"))).toBeLessThan(orderOf(entryEl("m1")));
  });

  it("同锚点多卡按 spawn 先后排序", () => {
    stateRef.current = play([welcome, completedMsg("m1"), spawn("a1", "m1"), spawn("a2", "m1"), completedMsg("m2")]);
    ui(<MessageFlow />);
    expect(orderOf(cardEl("a1"))).toBeLessThan(orderOf(cardEl("a2")));
    expect(orderOf(cardEl("a2"))).toBeLessThan(orderOf(entryEl("m2")));
  });
});

describe("MessageFlow 挂载（三态分流；消费 T4.1 槽位）", () => {
  const welcome: EventEnvelope = {
    v: 0,
    type: "connection.welcome",
    payload: { sessionId: "s1", model: "claude-sonnet-4-5", agentState: "idle" },
  };
  const snapshot: EventEnvelope = {
    v: 0,
    type: "session.snapshot",
    payload: {
      snapshot: {
        sessionId: "s1",
        model: "claude-sonnet-4-5",
        agentState: "idle",
        revision: 1,
        entries: [thinkEntry()],
      },
    },
  };

  it("entries 含 thinking entry → 💭 折叠条渲染（complete 态入流）", () => {
    stateRef.current = [welcome, snapshot].reduce(
      (s, e) => sessionReducer(s, { type: "event", event: e }),
      createInitialSessionState(),
    );
    ui(<MessageFlow />);
    expect(document.querySelector('.fb-wrap[data-kind="thinking"]')).not.toBeNull();
    expect(document.querySelector(".think-live")).toBeNull();
  });

  it("thinkingStreams.main 有值 → think-live 流式块渲染；delta 累积可见", () => {
    stateRef.current = [
      welcome,
      { v: 0, type: "thinking.stream.delta", payload: { instanceId: "main", delta: "第一段" } } as EventEnvelope,
      { v: 0, type: "thinking.stream.delta", payload: { instanceId: "main", delta: "·第二段" } } as EventEnvelope,
    ].reduce((s, e) => sessionReducer(s, { type: "event", event: e }), createInitialSessionState());
    ui(<MessageFlow />);
    expect(screen.getByText("第一段·第二段")).toBeTruthy();
    expect(screen.getByText("思考中")).toBeTruthy();
  });

  it("无 thinking 消息零渲染：无 entry 且槽位空 → 折叠条与流式块都不出现", () => {
    stateRef.current = [welcome, { ...snapshot, payload: { snapshot: { ...snapshot.payload.snapshot, entries: [] } } }].reduce(
      (s, e) => sessionReducer(s, { type: "event", event: e }),
      createInitialSessionState(),
    );
    ui(<MessageFlow />);
    expect(document.querySelector(".think-live")).toBeNull();
    expect(document.querySelector('.fb-wrap[data-kind="thinking"]')).toBeNull();
  });

  it("SubAgent 实例 thinking 流式槽位不进主消息流（F1.6 分流；归抽屉 T4.3 消费）", () => {
    stateRef.current = [
      welcome,
      { v: 0, type: "agent.spawned", payload: { agentId: "agent-1", task: "t", profileKind: "subagent-worker" } } as EventEnvelope,
      { v: 0, type: "thinking.stream.delta", payload: { instanceId: "agent-1", delta: "sub 思考" } } as EventEnvelope,
    ].reduce((s, e) => sessionReducer(s, { type: "event", event: e }), createInitialSessionState());
    ui(<MessageFlow />);
    expect(document.querySelector(".think-live")).toBeNull();
  });

  it("T10c：新形态主实例 steer 条目（agent-<hex>）渲染普通气泡；SubAgent 定向条目才渲染细条", () => {
    // 主实例 id 习得自快照 instances kind=main（agent-m1）；定向 steer 判别
    // = kind 判别（≠main id）而非字面值——主实例 steer 回归普通气泡
    const snap: EventEnvelope = {
      v: 0,
      type: "session.snapshot",
      payload: {
        snapshot: {
          sessionId: "s1",
          model: "claude-sonnet-4-5",
          agentState: "idle",
          revision: 2,
          entries: [
            { kind: "message", id: "st-1", role: "user", content: "主线 steer", ts: 1, steerState: "drained", instanceId: "agent-m1" },
            { kind: "message", id: "st-2", role: "user", content: "定向干预", ts: 2, steerState: "drained", instanceId: "agent-s1" },
          ],
          instances: [
            { instanceId: "agent-m1", kind: "main", profileKind: "main-session", state: "running", createdAt: "2026-08-16T14:00:00.000Z" },
          ],
        },
      },
    };
    stateRef.current = [welcome, snap].reduce(
      (s, e) => sessionReducer(s, { type: "event", event: e }),
      createInitialSessionState(),
    );
    ui(<MessageFlow />);
    expect(document.querySelectorAll('[data-kind="steer-directed"]')).toHaveLength(1);
    expect(document.querySelector('[data-target="agent-s1"]')).not.toBeNull();
    expect(screen.getByText("主线 steer")).toBeTruthy(); // 主实例 steer = 普通气泡
  });
});

// ── H-2 热修：滚动语义（去滚动触发 + 切换贴底 + 前插补偿回归）────────

describe("MessageFlow 滚动语义（H-2 热修）", () => {
  const msg = (id: string) =>
    ({ kind: "message", id, role: "user", content: `text-${id}`, ts: 1 }) as const;
  const stateWith = (sessionId: string, ids: string[]): SessionState => ({
    ...createInitialSessionState(),
    sessionId,
    view: "ready",
    entries: ids.map((id) => msg(id)),
    history: { hasMore: true, nextCursor: "cursor-1", loading: false, total: 99, paged: true },
  });
  const flowEl = () => document.querySelector<HTMLElement>(".msg-flow")!;
  /** jsdom 无布局：scrollHeight 以 own property 注入（configurable 可重定义）。 */
  const setScrollHeight = (h: number) =>
    Object.defineProperty(flowEl(), "scrollHeight", { value: h, configurable: true });
  const renderFlow = () => render(<I18nProvider><MessageFlow /></I18nProvider>);

  beforeEach(() => loadEarlierSpy.mockClear());

  it("滚顶不再触发 loadEarlier（滚动监听退役）；胶囊按钮为唯一触发面", () => {
    stateRef.current = stateWith("sA", ["m1", "m2"]);
    renderFlow();
    fireEvent.scroll(flowEl(), { target: { scrollTop: 0 } });
    expect(loadEarlierSpy).not.toHaveBeenCalled();
    // 按钮通道保留（胶囊可点 → 触发一次）
    fireEvent.click(screen.getByText(/加载更早的消息/));
    expect(loadEarlierSpy).toHaveBeenCalledTimes(1);
  });

  it("会话切换 → 贴底（不误判为前插吃旧会话陈旧高度）", () => {
    stateRef.current = stateWith("sA", ["m1", "m2"]);
    const { rerender } = renderFlow();
    // 旧会话内容高 1000：追加一条同会话消息采样锚定基线（非前插 → 贴底）
    setScrollHeight(1000);
    stateRef.current = stateWith("sA", ["m1", "m2", "m3"]);
    rerender(<I18nProvider><MessageFlow /></I18nProvider>);
    expect(flowEl().scrollTop).toBe(1000);
    // 模拟切换 loading 期内容坍塌：浏览器把 scrollTop 夹到 0（jsdom 无夹取，手动模拟）
    flowEl().scrollTop = 0;
    // 快照到达：新会话更短（高 300）。误判前插时补偿 = 300-1000+0 = -700
    setScrollHeight(300);
    stateRef.current = stateWith("sB", ["n1"]);
    rerender(<I18nProvider><MessageFlow /></I18nProvider>);
    expect(flowEl().scrollTop).toBe(300); // 贴底 = scrollHeight
  });

  it("同会话前插 → 视口锚定补偿保持（回归守护）", () => {
    stateRef.current = stateWith("sA", ["m1", "m2"]);
    const { rerender } = renderFlow();
    setScrollHeight(1000);
    stateRef.current = stateWith("sA", ["m1", "m2", "m3"]);
    rerender(<I18nProvider><MessageFlow /></I18nProvider>);
    // 用户滚到顶（scrollTop=0）→ 前插一页（新首条 m0，新增高度 300）
    flowEl().scrollTop = 0;
    setScrollHeight(1300);
    stateRef.current = stateWith("sA", ["m0", "m1", "m2", "m3"]);
    rerender(<I18nProvider><MessageFlow /></I18nProvider>);
    expect(flowEl().scrollTop).toBe(300); // 1300-1000+0：原首条保持在视口原位
  });
});

// ── T9 图片渲染：user 气泡与工具卡缩略图（MessageBubble/ToolCard 共用 ImageStrip） ──

describe("T9 图片渲染（气泡 + 工具卡缩略图）", () => {
  const play = (events: EventEnvelope[]): SessionState =>
    events.reduce((s, e) => sessionReducer(s, { type: "event", event: e }), createInitialSessionState());
  const TINY_PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

  it("user 消息携带 images → 气泡渲染缩略图（img src = data URL）", () => {
    const s = play([
      {
        v: 0,
        type: "chat.message.completed",
        payload: {
          entry: {
            kind: "message",
            id: "m-img",
            role: "user",
            content: "看图",
            ts: 2,
            images: [TINY_PNG],
          },
        },
      } satisfies EventEnvelope,
    ]);
    stateRef.current = { ...s, view: "ready", entries: s.entries };
    ui(<MessageFlow />);
    const img = screen.getAllByRole("img")[0]!;
    expect(img.getAttribute("src")).toBe(TINY_PNG);
    expect(img.closest(".msg")).not.toBeNull();
  });

  it("工具卡携带 images → 卡体渲染缩略图（展开后可见）", () => {
    const s = play([
      {
        v: 0,
        type: "tool.call.result",
        payload: {
          entry: {
            kind: "tool-call",
            id: "t-img",
            name: "browser",
            args: "{}",
            result: '{"saved":"/tmp/s.png"}',
            state: "done",
            durationMs: 5,
            ts: 3,
            images: [TINY_PNG],
          },
        },
      } satisfies EventEnvelope,
    ]);
    stateRef.current = { ...s, view: "ready", entries: s.entries };
    ui(<MessageFlow />);
    fireEvent.click(screen.getByText("browser")); // 展开卡体
    const img = screen.getAllByRole("img")[0]!;
    expect(img.getAttribute("src")).toBe(TINY_PNG);
    expect(img.closest(".tool-card")).not.toBeNull();
  });
});

/**
 * P2 ⑦ 网络重试批：NetworkRetryCard 内联等待卡——engine.retrying 帧
 * 到达渲染「网络重试中（第 N/3 次，约 Xs 后）」；流恢复（主线 delta）
 * 即清；最终失败换 EngineErrorCard（两卡不叠加）。
 */
describe("MessageFlow 网络重试状态卡（P2 ⑦）", () => {
  const welcome: EventEnvelope = {
    v: 0,
    type: "connection.welcome",
    payload: { sessionId: "s1", model: "claude-sonnet-4-5", agentState: "running" },
  };
  const retrying = (attempt: number, waitMs: number): EventEnvelope => ({
    v: 0,
    type: "engine.retrying",
    payload: { attempt, totalAttempts: 3, waitMs, message: "fetch failed" },
  });
  const play = (events: EventEnvelope[]): SessionState =>
    events.reduce((s, e) => sessionReducer(s, { type: "event", event: e }), createInitialSessionState());

  it("engine.retrying 帧 → 状态卡「网络重试中（第 2/3 次，约 30s 后）」+ provider 原文", () => {
    stateRef.current = play([welcome, retrying(2, 30_000)]);
    ui(<MessageFlow />);
    expect(screen.getByText("网络重试中（第 2/3 次，约 30s 后）")).not.toBeNull();
    expect(screen.getByText("fetch failed")).not.toBeNull();
  });

  it("无重试帧不渲染（null 卡零占位）", () => {
    stateRef.current = play([welcome]);
    ui(<MessageFlow />);
    expect(document.querySelector(".network-retry-card")).toBeNull();
  });

  it("流恢复（主线 delta）→ 状态卡消失；最终失败 → 换错误卡不叠加", () => {
    stateRef.current = play([welcome, retrying(1, 10_000), {
      v: 0,
      type: "chat.stream.delta",
      payload: { messageId: "e5", delta: "流恢复" },
    }]);
    const resumed = ui(<MessageFlow />);
    expect(document.querySelector(".network-retry-card")).toBeNull();
    cleanup();

    stateRef.current = play([welcome, retrying(1, 10_000), {
      v: 0,
      type: "engine.error",
      payload: { message: "503 Service Unavailable" },
    }]);
    ui(<MessageFlow />);
    expect(document.querySelector(".network-retry-card")).toBeNull();
    expect(document.querySelector(".engine-error-card")).not.toBeNull();
    void resumed;
  });
});
