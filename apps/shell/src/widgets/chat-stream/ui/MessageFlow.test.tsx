// @vitest-environment jsdom
/**
 * MessageFlow 挂载测试（thinking 三态分流；消费 T4.1 槽位）。
 *
 * 自 ThinkingBlock.test.tsx 拆出（T4.3：ThinkingBlock 上移 shared/ui 后，
 * MessageFlow 集成断言按 FSD 分层归位 widgets/chat-stream）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import type { EntryDto, ErrorEntryDto, EventEnvelope, ThinkingEntryDto } from "@helix/protocol";
import { createInitialSessionState, sessionReducer, type SessionState } from "@/entities/session/model/session-reducer";

// ── SessionContext mock（state 注入；selectIsEmpty 等保持真体）──
const stateRef: { current: SessionState } = { current: createInitialSessionState() };
/** loadEarlierHistory 探针（H-2：滚动触发退役 / 按钮唯一触发面断言）。 */
const loadEarlierSpy = vi.fn();
/** setDraft 探针（空态统一：草稿/真实空会话同构 SessionEmpty，chip 回填断言）。 */
const setDraftSpy = vi.fn();
vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({ state: stateRef.current, loadEarlierHistory: loadEarlierSpy, setDraft: setDraftSpy }),
  };
});

import MessageFlow, { type MessageFlowHandle } from "./MessageFlow";

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
    createdAt: "2026-08-16T14:02:00+08:00",
    ...over,
  };
}

afterEach(cleanup);

// jsdom navigator.language 默认 en-US：钉 zh-CN（产品断言语言，AG-14 白名单键）
localStorage.setItem("helix-lang", "zh-CN");

/** 空态统一（F(1.2).1 修订）：草稿（sessionId=null）与真实空会话（有 id 零
 *  条目）同构 SessionEmpty——HX 方标 + 呼吸文案 + 三枚建议 chip；草稿仅多
 *  一行「发送第一条消息后将创建会话」条件提示（消除手动新建 vs 管家建的
 *  空态不一致，用户裁决）。 */
describe("MessageFlow 空态统一（草稿/真实空会话同构 SessionEmpty）", () => {
  /** 草稿空态：手动新建会话（sessionId=null；connected 即 empty 成立）。 */
  const draftState = (): SessionState => ({
    ...createInitialSessionState(),
    sessionId: null,
    conn: "connected",
    view: "ready",
  });
  /** 真实空会话：管家建的、有 id 零条目。 */
  const realEmptyState = (): SessionState => ({
    ...createInitialSessionState(),
    sessionId: "s1",
    conn: "connected",
    view: "ready",
  });

  it("草稿空态：SessionEmpty 形态——HX 方标 + 三枚建议 chip + 草稿提示行；独立 DraftEmpty 退役", () => {
    stateRef.current = draftState();
    ui(<MessageFlow />);
    const root = document.querySelector(".session-empty")!;
    expect(root).not.toBeNull();
    expect(root.querySelector(".empty-logo")!.textContent).toBe("HX");
    expect(root.querySelectorAll(".empty-suggest button")).toHaveLength(3);
    expect(root.querySelector(".empty-hint")!.textContent).toContain("发送第一条消息后将创建会话");
    // P-1-draft-empty 独立容器退役：草稿不再走另一套空态
    expect(document.querySelector(".draft-empty")).toBeNull();
  });

  it("真实空会话：同构形态——HX 方标 + 三枚 chip 齐；无草稿提示行", () => {
    stateRef.current = realEmptyState();
    ui(<MessageFlow />);
    const root = document.querySelector(".session-empty")!;
    expect(root.querySelector(".empty-logo")!.textContent).toBe("HX");
    expect(root.querySelectorAll(".empty-suggest button")).toHaveLength(3);
    expect(root.querySelector(".empty-hint")).toBeNull();
  });

  it("草稿态建议 chip 点击 → 回填草稿 + 聚焦回调（setDraft 草稿态合法）", () => {
    stateRef.current = draftState();
    const focusSpy = vi.fn();
    ui(<MessageFlow onFocusInput={focusSpy} />);
    fireEvent.click(document.querySelector(".empty-suggest button")!);
    expect(setDraftSpy).toHaveBeenCalledWith("读一下 packages/protocol 的结构");
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });
});

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

  it("系统注入细条化：主实例 source=closure/progress 条目渲染细条（非气泡）；source=user/缺省保持气泡；queued steer 归队列坞", () => {
    // 时间轴语义分层：气泡 = 人说的话，细条 = 系统的注入（closure/progress）。
    // source 判别优先于 instanceId——主实例的 closure/progress 条目同样细条化；
    // drain 落盘语义：快照里 steerState=queued 的条目抽取归队列坞（不上时间轴）
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
            { kind: "message", id: "u-1", role: "user", content: "用户原话", ts: 1, instanceId: "agent-m1" },
            { kind: "message", id: "c-1", role: "user", content: "agent-3 closure: 收口摘要", ts: 2, source: "closure", instanceId: "agent-m1" },
            { kind: "message", id: "p-1", role: "user", content: "进展报告中", ts: 3, source: "progress", steerState: "drained", instanceId: "agent-m1" },
            { kind: "message", id: "s-1", role: "user", content: "手动 steer", ts: 4, source: "user", steerState: "drained", instanceId: "agent-m1" },
            { kind: "message", id: "q-1", role: "user", content: "排队中的 steer", ts: 5, steerState: "queued", instanceId: "agent-m1" },
          ],
          pendingSteer: [{ entryId: "q-1", text: "排队中的 steer" }],
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
    const injects = document.querySelectorAll('[data-kind="system-inject"]');
    expect(injects).toHaveLength(2);
    expect(document.querySelector('[data-source="closure"]')!.textContent).toContain("agent-3 closure: 收口摘要");
    expect(document.querySelector('[data-source="progress"]')!.textContent).toContain("进展报告中");
    // 细条不披气泡形态；用户原话与手动 steer（drained 落盘）仍是气泡
    expect(document.querySelector('[data-source="closure"]')!.closest(".msg")).toBeNull();
    expect(screen.getByText("用户原话").closest(".msg")).not.toBeNull();
    expect(screen.getByText("手动 steer").closest(".msg")).not.toBeNull();
    // queued steer 不上时间轴（时间轴面断言）；坞已随 T1 迁 ChatStatusBar 状态行左槽
    expect(screen.queryByText("排队中的 steer")?.closest(".msg") ?? null).toBeNull();
    expect(document.querySelector('[data-kind="steer-dock"]')).toBeNull();
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

  it("同会话快照整体替换（旧首条已出窗）→ 不误判前插，吸附态贴底（不吃陈旧 prevHeight 补偿）", () => {
    // 重连恢复尾窗漂移场景（consumers/snapshot.ts entries 整体替换）：
    // 首条 id 必变但旧首条已不在新 entries——非真前插。
    stateRef.current = stateWith("sA", ["m1", "m2", "m3"]);
    const { rerender } = renderFlow();
    // 追加一条采样锚定基线（非前插 → 贴底；prevHeight=1000，prevFirstId=m1）
    setScrollHeight(1000);
    stateRef.current = stateWith("sA", ["m1", "m2", "m3", "m4"]);
    rerender(<I18nProvider><MessageFlow /></I18nProvider>);
    expect(flowEl().scrollTop).toBe(1000);
    // 用户微上滚 30px（仍在 AT_BOTTOM_PX 阈值内，吸附态保持）
    flowEl().scrollTop = 970;
    fireEvent.scroll(flowEl(), { target: { scrollTop: 970 } });
    // 快照整体替换：尾窗漂移 → m1/m2 出窗（新首条 m3，长度 4→5 触发 effect）
    setScrollHeight(800);
    stateRef.current = stateWith("sA", ["m3", "m4", "m5", "m6", "m7"]);
    rerender(<I18nProvider><MessageFlow /></I18nProvider>);
    // 误判前插时补偿 = 800-1000+970 = 770；正确行为 = 吸附贴底 800
    expect(flowEl().scrollTop).toBe(800);
  });
});

// ── 回底驻留吸附（1s dwell）：上滚脱附 / 回底驻留视觉 / 期满吸附 / 驻留取消 ──

describe("MessageFlow 回底驻留吸附（1s dwell）", () => {
  const msg = (id: string) =>
    ({ kind: "message", id, role: "user", content: `text-${id}`, ts: 1 }) as const;
  const stateWith = (sessionId: string, ids: string[], streaming: string | null = null): SessionState => ({
    ...createInitialSessionState(),
    sessionId,
    view: "ready",
    entries: ids.map((id) => msg(id)),
    streaming: streaming === null ? null : { messageId: "sm-1", text: streaming, ts: 1 },
    history: { hasMore: true, nextCursor: "cursor-1", loading: false, total: 99, paged: true },
  });
  const flowEl = () => document.querySelector<HTMLElement>(".msg-flow")!;
  const setScrollHeight = (h: number) =>
    Object.defineProperty(flowEl(), "scrollHeight", { value: h, configurable: true });
  const renderFlow = () => render(<I18nProvider><MessageFlow /></I18nProvider>);
  /** 快进到「吸附态且已贴底」（初始吸附，追加流式 chunk 采样基线）。 */
  const engageAtBottom = (rerender: (n: React.ReactElement) => void) => {
    setScrollHeight(1000);
    stateRef.current = stateWith("sA", ["m1", "m2"], "chunk-1");
    rerender(<I18nProvider><MessageFlow /></I18nProvider>);
    expect(flowEl().scrollTop).toBe(1000); // 吸附态跟随贴底
  };

  afterEach(() => vi.useRealTimers());

  it("用户上滚脱附后：流式 chunk 不再拽回底部（scrollTop 保持）", () => {
    stateRef.current = stateWith("sA", ["m1", "m2"]);
    const { rerender } = renderFlow();
    engageAtBottom(rerender);
    // 用户上滚（距底 700 > 40）→ 脱附
    fireEvent.scroll(flowEl(), { target: { scrollTop: 300 } });
    setScrollHeight(1200);
    stateRef.current = stateWith("sA", ["m1", "m2"], "chunk-2");
    rerender(<I18nProvider><MessageFlow /></I18nProvider>);
    expect(flowEl().scrollTop).toBe(300);
  });

  it("滚回底部 → 1s 驻留（视觉提示）→ 期满正式吸附", () => {
    vi.useFakeTimers();
    stateRef.current = stateWith("sA", ["m1", "m2"]);
    const { rerender } = renderFlow();
    engageAtBottom(rerender);
    fireEvent.scroll(flowEl(), { target: { scrollTop: 300 } }); // 脱附
    // 用户滚回底部（距底 30 ≤ 40）→ 驻留开始，呼吸底线出现
    fireEvent.scroll(flowEl(), { target: { scrollTop: 970 } });
    expect(screen.queryByTestId("snap-dwell")).not.toBeNull();
    // 驻留期内流式增长：视口不被拽动（内容增长不触发 scroll，驻留不误取消）
    setScrollHeight(1200);
    stateRef.current = stateWith("sA", ["m1", "m2"], "chunk-2");
    rerender(<I18nProvider><MessageFlow /></I18nProvider>);
    expect(flowEl().scrollTop).toBe(970);
    // 驻留满 1s → 正式吸附：贴到新底部 + 视觉提示消失；后续 chunk 恢复跟随
    act(() => vi.advanceTimersByTime(1000));
    expect(flowEl().scrollTop).toBe(1200);
    expect(screen.queryByTestId("snap-dwell")).toBeNull();
    setScrollHeight(1400);
    stateRef.current = stateWith("sA", ["m1", "m2"], "chunk-3");
    rerender(<I18nProvider><MessageFlow /></I18nProvider>);
    expect(flowEl().scrollTop).toBe(1400);
  });

  it("驻留期内用户主动滚离 → 驻留取消（提示消失，期满不吸附）", () => {
    vi.useFakeTimers();
    stateRef.current = stateWith("sA", ["m1", "m2"]);
    const { rerender } = renderFlow();
    engageAtBottom(rerender);
    fireEvent.scroll(flowEl(), { target: { scrollTop: 300 } }); // 脱附
    fireEvent.scroll(flowEl(), { target: { scrollTop: 970 } }); // 回底 → 驻留开始
    expect(screen.queryByTestId("snap-dwell")).not.toBeNull();
    fireEvent.scroll(flowEl(), { target: { scrollTop: 500 } }); // 驻留期内滚离 → 取消
    expect(screen.queryByTestId("snap-dwell")).toBeNull();
    act(() => vi.advanceTimersByTime(1500));
    setScrollHeight(1200);
    stateRef.current = stateWith("sA", ["m1", "m2"], "chunk-2");
    rerender(<I18nProvider><MessageFlow /></I18nProvider>);
    expect(flowEl().scrollTop).toBe(500); // 未吸附：流式不拽回
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

// ── error entry 批：错误条目时间轴原位红条（EntryView error 分支）──

describe("MessageFlow 错误条目原位红条（error entry 批）", () => {
  const welcome: EventEnvelope = {
    v: 0,
    type: "connection.welcome",
    payload: { sessionId: "s1", model: "claude-sonnet-4-5", agentState: "idle" },
  };
  const errorEntry = (id: string, message: string): ErrorEntryDto => ({
    kind: "error",
    id,
    instanceId: "main",
    message,
    turnId: "t1",
    createdAt: "2026-09-03T00:00:01.000Z",
  });
  const play = (events: EventEnvelope[]): SessionState =>
    events.reduce((s, e) => sessionReducer(s, { type: "event", event: e }), createInitialSessionState());

  it("快照 entries 含 error 条目 → 归组渲染：最后一轮展开红条（ee-head/ee-body 族）+ 徽标行（刷新后原位可见）", () => {
    stateRef.current = play([
      welcome,
      {
        v: 0,
        type: "session.snapshot",
        payload: {
          snapshot: {
            sessionId: "s1",
            model: "claude-sonnet-4-5",
            agentState: "idle",
            revision: 2,
            entries: [
              { kind: "message", id: "m1", role: "user", content: "问一句", ts: 1 },
              errorEntry("e2", "429: 限额已满"),
            ],
          },
        },
      },
    ]);
    ui(<MessageFlow />);
    const bar = document.querySelector(".engine-error-card");
    expect(bar).not.toBeNull();
    expect(bar!.querySelector(".ee-head")).not.toBeNull();
    expect(bar!.querySelector(".ee-body")!.textContent).toBe("429: 限额已满"); // 红条原文透传
    expect(document.querySelector(".ee-badge")!.textContent).toContain("429: 限额已满"); // 徽标行同现（兼展开切换钮）
    // 原位：错误组在 m1 之后（ entries 序列序）
    const kids = Array.from(document.querySelector(".session-active")!.children);
    const msgIdx = kids.findIndex((k) => k.contains(screen.getByText("问一句")));
    const errIdx = kids.findIndex((k) => k.contains(bar!));
    expect(msgIdx).toBeGreaterThanOrEqual(0);
    expect(errIdx).toBeGreaterThan(msgIdx);
  });

  it("失败链帧序（engine.error → error.entry）→ 同一错误不双显（瞬态卡清除，原位条留存）", () => {
    stateRef.current = play([
      welcome,
      { v: 0, type: "engine.error", payload: { message: "503 Service Unavailable" } },
      { v: 0, type: "error.entry", payload: { entry: errorEntry("e9", "503 Service Unavailable") } },
    ]);
    ui(<MessageFlow />);
    // 原位红条唯一呈现面（瞬态卡已随 error.entry 帧清除）
    expect(document.querySelectorAll(".engine-error-card")).toHaveLength(1);
  });
});

// ── error entry 批：错误条目轮次折叠（引擎错误体验批）──

describe("MessageFlow 错误条目轮次折叠（引擎错误体验批）", () => {
  const welcome: EventEnvelope = {
    v: 0,
    type: "connection.welcome",
    payload: { sessionId: "s1", model: "claude-sonnet-4-5", agentState: "idle" },
  };
  const errorEntry = (id: string, message: string, turnId: string): ErrorEntryDto => ({
    kind: "error",
    id,
    instanceId: "main",
    message,
    turnId,
    createdAt: "2026-09-19T00:00:01.000Z",
  });
  const msgEntry = (id: string, content: string): EntryDto =>
    ({ kind: "message", id, role: "assistant", content, ts: 1 }) as EntryDto;
  const snapshotWith = (entries: EntryDto[]): EventEnvelope => ({
    v: 0,
    type: "session.snapshot",
    payload: { snapshot: { sessionId: "s1", model: "claude-sonnet-4-5", agentState: "idle", revision: 2, entries } },
  });
  const play = (events: EventEnvelope[]): SessionState =>
    events.reduce((s, e) => sessionReducer(s, { type: "event", event: e }), createInitialSessionState());
  const badgeOf = (turnId: string) => document.querySelector(`.ee-badge[data-turn-id="${turnId}"]`)!;
  const groupBars = (turnId: string) =>
    document.querySelectorAll(`.ee-group[data-turn-id="${turnId}"] .engine-error-card`);

  it("多轮多错误归组：历史轮折叠成一行徽标（无红条），当前轮（最后一轮）默认展开全量", () => {
    stateRef.current = play([
      welcome,
      snapshotWith([
        msgEntry("m1", "第一轮回复"),
        errorEntry("e1", "Stream ended without finish_reason", "t1"),
        msgEntry("m2", "用户救活后第二轮"),
        errorEntry("e2", "429: 限额已满", "t2"),
      ]),
    ]);
    ui(<MessageFlow />);
    // 两组徽标行各一（t1 历史 / t2 当前）
    expect(document.querySelectorAll(".ee-badge")).toHaveLength(2);
    // 历史轮 t1：仅徽标行，零红条（不在主流独立占位）
    expect(groupBars("t1")).toHaveLength(0);
    // 当前轮 t2：默认展开全量红条
    expect(groupBars("t2")).toHaveLength(1);
  });

  it("同轮多条合并计数：徽标 ×N + 展开全量；当前轮多错误全量可见", () => {
    stateRef.current = play([
      welcome,
      snapshotWith([
        msgEntry("m1", "第一轮回复"),
        errorEntry("e1", "fetch failed", "t1"),
        errorEntry("e2", "Stream ended without finish_reason", "t1"),
        errorEntry("e3", "ECONNRESET", "t1"),
      ]),
    ]);
    ui(<MessageFlow />);
    // 单一徽标（同轮合并不重复占位），计数 ×3，首条消息摘要
    expect(document.querySelectorAll(".ee-badge")).toHaveLength(1);
    expect(badgeOf("t1").textContent).toContain("×3");
    expect(badgeOf("t1").textContent).toContain("fetch failed");
    // 当前轮展开全量：3 条红条
    expect(groupBars("t1")).toHaveLength(3);
  });

  it("message 截断 40 字符：长消息徽标摘要截断（省略号结尾）", () => {
    const long = "a".repeat(60);
    stateRef.current = play([
      welcome,
      snapshotWith([msgEntry("m1", "m"), errorEntry("e1", long, "t1")]),
    ]);
    ui(<MessageFlow />);
    const text = badgeOf("t1").querySelector(".ee-badge-text")!.textContent!;
    expect(text).toBe("a".repeat(40) + "…");
    // 展开后全量消息不截断（红条原文透传）
    expect(groupBars("t1")[0]!.textContent).toContain(long);
  });

  it("徽标可点开历史轮展开 / 再点收起（aria-expanded 两态）", () => {
    stateRef.current = play([
      welcome,
      snapshotWith([
        msgEntry("m1", "m"),
        errorEntry("e1", "历史轮错误", "t1"),
        msgEntry("m2", "m2"),
        errorEntry("e2", "当前轮错误", "t2"),
      ]),
    ]);
    ui(<MessageFlow />);
    expect(badgeOf("t1").getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(badgeOf("t1"));
    expect(badgeOf("t1").getAttribute("aria-expanded")).toBe("true");
    expect(groupBars("t1")).toHaveLength(1); // 展开可见
    fireEvent.click(badgeOf("t1"));
    expect(badgeOf("t1").getAttribute("aria-expanded")).toBe("false");
    expect(groupBars("t1")).toHaveLength(0); // 收起回徽标
  });

  it("实时链：新轮错误条目到达 → 新组成为当前轮展开，旧轮收起（不叠加展开）", () => {
    stateRef.current = play([
      welcome,
      { v: 0, type: "error.entry", payload: { entry: errorEntry("e1", "第一轮断流", "t1") } },
    ]);
    ui(<MessageFlow />);
    expect(groupBars("t1")).toHaveLength(1); // 唯一轮 = 当前轮展开
    // 用户收起 t1（override=collapsed）后新轮错误到达：新轮展开，t1 保持折叠
    fireEvent.click(badgeOf("t1"));
    cleanup();
    stateRef.current = play([
      welcome,
      { v: 0, type: "error.entry", payload: { entry: errorEntry("e1", "第一轮断流", "t1") } },
      { v: 0, type: "chat.message.completed", payload: { entry: { kind: "message", id: "m-continue", role: "user", content: "继续", ts: 2 } } },
      { v: 0, type: "error.entry", payload: { entry: errorEntry("e2", "第二轮断流", "t2") } },
    ]);
    ui(<MessageFlow />);
    expect(groupBars("t2")).toHaveLength(1); // 新当前轮默认展开
    expect(groupBars("t1")).toHaveLength(0); // 旧轮归折叠（历史轮语义）
  });

  it("组位 = 所属轮末条 error 原位：错误条仍排在轮内其它条目之后（归组不迁移位置）", () => {
    stateRef.current = play([
      welcome,
      snapshotWith([
        msgEntry("m1", "轮内消息"),
        errorEntry("e1", "断流甲", "t1"),
        errorEntry("e2", "断流乙", "t1"),
        msgEntry("m2", "下一轮消息"),
      ]),
    ]);
    ui(<MessageFlow />);
    const kids = Array.from(document.querySelector(".session-active")!.children);
    const idxOf = (el: Element | null) => kids.findIndex((k) => k === el || k.contains(el!));
    const groupIdx = idxOf(document.querySelector(".ee-group"));
    expect(groupIdx).toBeGreaterThan(idxOf(screen.getByText("轮内消息").closest(".msg"))); // 徽标在轮内消息后
    expect(groupIdx).toBeLessThan(idxOf(screen.getByText("下一轮消息").closest(".msg"))); // 不逃出轮外
    // 合并后仅一个组容器（e1 位置不留独立占位）
    expect(document.querySelectorAll(".ee-group")).toHaveLength(1);
  });
});

// ── 浮动件退役（T1：SteerQueueDock/WorkPhaseDot 迁 ChatStatusBar 状态行；挂载面守护）──

describe("MessageFlow 浮动件退役（T1 状态行收拢）", () => {
  const welcome: EventEnvelope = {
    v: 0,
    type: "connection.welcome",
    payload: { sessionId: "s1", model: "claude-sonnet-4-5", agentState: "idle" },
  };
  const running: EventEnvelope = { v: 0, type: "agent.state.changed", payload: { state: "running" } };
  const thinkDelta: EventEnvelope = {
    v: 0,
    type: "thinking.stream.delta",
    payload: { instanceId: "main", delta: "推理…" },
  };

  it("thinking 活跃态 + queued steer → 光点/坞均不在 MessageFlow 内（归 ChatStatusBar 三槽）", () => {
    stateRef.current = [running, thinkDelta].reduce(
      (s, e) => sessionReducer(s, { type: "event", event: e } as never),
      sessionReducer(createInitialSessionState(), { type: "event", event: welcome } as never),
    );
    stateRef.current = {
      ...stateRef.current,
      steerQueue: [{ id: "q-1", text: "排队", confirmed: true, ts: 1 }],
    };
    ui(<MessageFlow />);
    expect(document.querySelector(".wp-inline, .wp-float")).toBeNull();
    expect(document.querySelector('[data-kind="steer-dock"]')).toBeNull();
    // snap-dwell 呼吸线原位保留（滚动语义，非浮动件）
    expect(document.querySelector(".msg-flow-wrap")).not.toBeNull();
  });
});

// ── F5 批 #7（TR-85）：scrollToLastCompaction 窄接口（ref 句柄替代跨层 DOM 直达）──
describe("MessageFlowHandle.scrollToLastCompaction（F5 批 #7 / TR-85）", () => {
  function compactionState(): SessionState {
    const s = createInitialSessionState();
    return {
      ...s,
      sessionId: "s1",
      view: "ready",
      entries: [
        {
          kind: "compaction",
          id: "compact-1",
          instanceId: "main",
          tokensBefore: 340_000,
          tokensAfter: 20_000,
          summary: "摘要",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 2, cost: 0.01 },
          createdAt: new Date(2026, 7, 16, 14, 5).toISOString(),
        },
      ],
    };
  }

  it("ref 句柄触发本组件子树内最后一条 compaction 条 scrollIntoView", () => {
    stateRef.current = compactionState();
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const ref = React.createRef<MessageFlowHandle>();
    ui(<MessageFlow ref={ref} />);
    expect(document.querySelector('.fb-wrap[data-kind="compaction"]')).not.toBeNull();
    act(() => ref.current!.scrollToLastCompaction());
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("无 compaction 条目时零动作（不抛错不滚动）", () => {
    stateRef.current = { ...createInitialSessionState(), sessionId: "s1", view: "ready" };
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const ref = React.createRef<MessageFlowHandle>();
    ui(<MessageFlow ref={ref} />);
    act(() => ref.current!.scrollToLastCompaction());
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
