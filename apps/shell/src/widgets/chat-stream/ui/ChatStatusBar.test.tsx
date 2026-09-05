// @vitest-environment jsdom
/**
 * ChatStatusBar chat 状态行组件测试（T1）。
 *
 * 钉纪律：
 * - 常驻占位：无条件渲染（idle + 空队列 + 无会话的初始态也挂载）——高度恒定，
 *   内容有无不影响布局（对话气泡卡片与输入框间距恒定）；
 * - 三槽结构：左（SteerQueueDock 行内形态）/ 中（DiffStatChip 两 chip 统计，
 *   T3+T4 diff 批）/ 右（WorkPhaseDot 行内形态）；
 * - 左槽：空队列时槽位空（行仍在）；非空 → 计数 chip，点击展开清单（向上弹出）；
 * - 右槽：idle 不渲染光点（WorkPhaseDot 现状逻辑保留）；thinking → 呼吸点+标签；
 * - E-89：状态行位于滚动容器之外（常驻条不驻滚动流）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { createInitialSessionState, sessionReducer, type SessionState } from "@/entities/session/model/session-reducer";

const stateRef: { current: SessionState } = { current: createInitialSessionState() };
vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return { ...orig, useSession: () => ({ state: stateRef.current, sendDiffGet: () => false }) };
});

import ChatStatusBar from "./ChatStatusBar";

afterEach(cleanup);

// jsdom navigator.language 默认 en-US：钉 zh-CN（产品断言语言）
localStorage.setItem("helix-lang", "zh-CN");

function ui() {
  return render(
    <I18nProvider>
      <ChatStatusBar />
    </I18nProvider>,
  );
}

function stateWith(over: Partial<SessionState>): SessionState {
  return { ...createInitialSessionState(), sessionId: "s1", view: "ready", ...over };
}

/** 经事件播放构造（workPhase 派生依赖 lastStreamKind 等帧习得字段）。 */
const play = (events: { v: 0; type: string; payload: unknown }[]): SessionState =>
  events.reduce(
    (s, e) => sessionReducer(s, { type: "event", event: e as never }),
    createInitialSessionState(),
  );
const welcome = { v: 0, type: "connection.welcome", payload: { sessionId: "s1", model: "claude-sonnet-4-5", agentState: "idle" } } as const;
const running = { v: 0, type: "agent.state.changed", payload: { state: "running" } } as const;
const thinkDelta = { v: 0, type: "thinking.stream.delta", payload: { instanceId: "main", delta: "推理…" } } as const;

/** thinking 段位态（agentState=running + thinking 流式槽活跃，事件播放驱动）。 */
function thinkingState(): SessionState {
  return { ...play([welcome, running, thinkDelta]), view: "ready" };
}

describe("ChatStatusBar 常驻占位（T1）", () => {
  it("无条件渲染：idle + 空队列 + 无会话的初始态 → 状态行仍挂载（内容有无不影响布局）", () => {
    stateRef.current = createInitialSessionState();
    ui();
    expect(document.querySelector('[data-testid="chat-status-bar"]')).not.toBeNull();
  });

  it("行高恒定类名（chat-status-bar；height 固定断言见 ChatStatusBar.css.test.ts）", () => {
    stateRef.current = createInitialSessionState();
    ui();
    expect(document.querySelector('[data-testid="chat-status-bar"]')!.classList.contains("chat-status-bar")).toBe(true);
  });
});

describe("ChatStatusBar 三槽结构（左/中/右 flex）", () => {
  it("左槽存在（空队列时槽位空、行仍在）；中槽 diff 预留空占位；右槽存在（idle 空）", () => {
    stateRef.current = stateWith({});
    ui();
    const bar = document.querySelector('[data-testid="chat-status-bar"]')!;
    const left = bar.querySelector('[data-testid="chat-status-left"]');
    const mid = bar.querySelector('[data-testid="chat-status-diff-slot"]');
    const right = bar.querySelector('[data-testid="chat-status-right"]');
    expect(left).not.toBeNull();
    expect(mid).not.toBeNull();
    expect(right).not.toBeNull();
    // 空态：左槽无 dock、中槽空内容、右槽无光点
    expect(left!.querySelector('[data-kind="steer-dock"]')).toBeNull();
    expect(mid!.textContent).toBe("");
    expect(right!.querySelector(".wp-inline")).toBeNull();
    // 槽序：左 → 中 → 右（flex 行内布局序）
    const slots = Array.from(bar.children);
    expect(slots.indexOf(left!)).toBeLessThan(slots.indexOf(mid!));
    expect(slots.indexOf(mid!)).toBeLessThan(slots.indexOf(right!));
  });
});

describe("ChatStatusBar 左槽 SteerQueueDock（行内形态迁移）", () => {
  it("非空队列 → 计数 chip 落左槽；点击展开清单、再点击折叠（交互保留）", () => {
    stateRef.current = stateWith({
      steerQueue: [{ id: "e7", text: "排队内容", confirmed: true, ts: 1 }],
    });
    const { container } = ui();
    const left = document.querySelector('[data-testid="chat-status-left"]')!;
    const dock = left.querySelector('[data-kind="steer-dock"]');
    expect(dock).not.toBeNull();
    // dock 不在左槽外漂移（行内 = 槽的子元素）
    expect(container.querySelector('[data-kind="steer-dock"]')).toBe(dock);
    const toggle = dock!.querySelector(".sdq-toggle");
    expect(toggle!.textContent).toContain("1 条注入排队中");
    // 展开 → 清单挂载；折叠 → 消失
    fireEvent.click(toggle!);
    expect(dock!.querySelectorAll(".sdq-item")).toHaveLength(1);
    expect(dock!.querySelector(".sdq-item")!.textContent).toContain("排队内容");
    fireEvent.click(toggle!);
    expect(dock!.querySelector(".sdq-list")).toBeNull();
  });
});

describe("ChatStatusBar 中槽 DiffStatChip（T3+T4 diff 批）", () => {
  it("diff 有数据 → chip 组落中槽（data-testid=diff-stat-chips）", () => {
    stateRef.current = stateWith({
      diff: { turnId: "t-1", phase: "active", adds: 12, dels: 4, fileCount: 3 },
    });
    ui();
    const mid = document.querySelector('[data-testid="chat-status-diff-slot"]')!;
    const chips = mid.querySelector('[data-testid="diff-stat-chips"]');
    expect(chips).not.toBeNull();
    expect(chips!.textContent).toContain("+12");
    expect(chips!.textContent).toContain("−4");
  });

  it("点击中槽 chip → onOpenDiff 回调（详情窗由 pages 层承接）", () => {
    const onOpenDiff = vi.fn();
    stateRef.current = stateWith({
      diff: { turnId: "t-1", phase: "active", adds: 3, dels: 1, fileCount: 1 },
    });
    render(
      <I18nProvider>
        <ChatStatusBar onOpenDiff={onOpenDiff} />
      </I18nProvider>,
    );
    fireEvent.click(document.querySelector('[data-testid="diff-stat-chips"]')!);
    expect(onOpenDiff).toHaveBeenCalledTimes(1);
  });
});

describe("ChatStatusBar 右槽 WorkPhaseDot（行内形态迁移）", () => {
  it("idle → 右槽空（现状 idle 不渲染逻辑保留）；thinking → 呼吸点+文字标签（data-phase）", () => {
    stateRef.current = stateWith({});
    ui();
    expect(document.querySelector('[data-testid="chat-status-right"]')!.querySelector(".wp-inline")).toBeNull();
    cleanup();

    stateRef.current = thinkingState();
    ui();
    const right = document.querySelector('[data-testid="chat-status-right"]')!;
    const dot = right.querySelector(".wp-inline");
    expect(dot).not.toBeNull();
    expect(dot!.getAttribute("data-phase")).toBe("thinking");
    expect(dot!.textContent).toContain("思考中");
    expect(screen.getByText("思考中").closest('[data-testid="chat-status-right"]')).not.toBeNull();
  });

  it("workPhase 派生回归：running + 无槽位活跃 → working 段位", () => {
    stateRef.current = { ...play([welcome, running]), view: "ready" };
    ui();
    const dot = document.querySelector('[data-testid="chat-status-right"] .wp-inline');
    expect(dot).not.toBeNull();
    expect(dot!.getAttribute("data-phase")).toBe("working");
  });
});
