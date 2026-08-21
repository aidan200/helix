// @vitest-environment jsdom
/**
 * MessageFlow 挂载测试（thinking 三态分流；消费 T4.1 槽位）。
 *
 * 自 ThinkingBlock.test.tsx 拆出（T4.3：ThinkingBlock 上移 shared/ui 后，
 * MessageFlow 集成断言按 FSD 分层归位 widgets/chat-stream）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import type { EventEnvelope, ThinkingEntryDto } from "@helix/protocol";
import { createInitialSessionState, sessionReducer, type SessionState } from "@/entities/session/model/session-reducer";

// ── SessionContext mock（state 注入；selectIsEmpty 等保持真体）──
const stateRef: { current: SessionState } = { current: createInitialSessionState() };
vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return { ...orig, useSession: () => ({ state: stateRef.current }) };
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
