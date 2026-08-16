// @vitest-environment jsdom
/**
 * thinking 块组件测试（F2.3/F2.4；test-design §2.2 F2.3 UI 行）。
 *
 * 三态渲染面：streaming（think-live muted 流式+光标+「思考中」标签）/
 * complete（💭 折叠条 Ns·N tokens+实例 chip，点击展开/收起 aria-expanded 同步）/
 * 无块零渲染（MessageFlow 挂载判定：无 thinking entry 且流式槽位空 → 零渲染）。
 * 三态互斥与 complete 不可逆的 reducer 面已由 session-reducer-v01.test.ts 守护，
 * 此处消费 T4.1 槽位做渲染断言（mock 帧驱动，不依赖 daemon 事件源）。
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
import { ThinkingEntryView, ThinkingLiveView } from "./ThinkingBlock";

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

describe("ThinkingLiveView（streaming 态）", () => {
  it("muted 流式块：「思考中」标签 + accent 脉冲点 + 累积文本 + 光标", () => {
    ui(<ThinkingLiveView text="先拆任务" />);
    const live = document.querySelector(".think-live");
    expect(live).not.toBeNull();
    expect(live!.querySelector(".tl-label .hud-dot-pulse")).not.toBeNull();
    expect(screen.getByText("思考中")).toBeTruthy();
    expect(screen.getByText("先拆任务")).toBeTruthy();
    expect(live!.querySelector(".stream-cursor")).not.toBeNull();
  });
});

describe("ThinkingEntryView（complete 折叠条）", () => {
  it("「💭 已思考 12s · 847 tokens」+ 实例 chip；duration 取整秒、<1k 原值", () => {
    ui(<ThinkingEntryView entry={thinkEntry()} />);
    expect(screen.getByText("已思考 12s · 847 tokens")).toBeTruthy();
    expect(screen.getByText("main", { selector: ".who-chip" })).toBeTruthy();
  });

  it("tokens 走 fmtTokens 档位（8400 → 8k）", () => {
    ui(<ThinkingEntryView entry={thinkEntry({ reasoningTokens: 8_400 })} />);
    expect(screen.getByText("已思考 12s · 8k tokens")).toBeTruthy();
  });

  it("点击展开全文回看再收起：aria-expanded 与 .open 同步（F2.4）", () => {
    ui(<ThinkingEntryView entry={thinkEntry()} />);
    const btn = screen.getByRole("button", { name: /已思考 12s/ });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    const wrap = document.querySelector('.fb-wrap[data-kind="thinking"]');
    expect(wrap!.className).not.toContain("open");

    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(wrap!.className).toContain("open");
    expect(screen.getByText(/盘点当前态/)).toBeTruthy();

    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(wrap!.className).not.toContain("open");
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
