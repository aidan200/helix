// @vitest-environment jsdom
/**
 * ChatPage 抽屉接线测试（T4.3；P-1 卡片 → P-2 抽屉寻址 + 终止链 toast）。
 *
 * - 卡片点击打开抽屉（selectedAgentId 组件状态，非 URL；review.md Mock 载体口径）；
 * - 抽屉打开时衬底弱化（.app[data-drawer]）；
 * - agent.killed 到达 → kill toast 交代（终止链末端；卡片/抽屉双视图同帧）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ThemeProvider } from "@/shared/ui/theme";
import { ToastProvider } from "@/shared/ui/Toast";
import type { EventEnvelope } from "@helix/protocol";
import { createInitialSessionState, sessionReducer, type SessionAction, type SessionState } from "@/entities/session/model/session-reducer";

const killInstance = vi.fn();
const subscribeInstance = vi.fn();
const unsubscribeInstance = vi.fn();
const devDispatchEvent = vi.fn();
const consumeKillToast = vi.fn();
const switchSession = vi.fn();
const newDraft = vi.fn();
const deleteSession = vi.fn();
const requestSessionList = vi.fn();
const stateRef: { current: SessionState } = { current: createInitialSessionState() };
vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({
      state: stateRef.current,
      // 拓扑面（T3.2 侧栏/顶栏消费面）：活跃即 mock state
      topology: { active: stateRef.current, background: {}, list: [] },
      switchSession,
      newDraft,
      deleteSession,
      requestSessionList,
      killInstance,
      subscribeInstance,
      unsubscribeInstance,
      devDispatchEvent,
      consumeRestoreToast: () => {},
      consumeSpawnToast: () => {},
      consumeKillToast,
    }),
  };
});

import ChatPage from "./ChatPage";

function play(events: SessionAction[]): SessionState {
  return events.reduce(sessionReducer, createInitialSessionState());
}

const ev = (event: EventEnvelope): SessionAction => ({ type: "event", event });

function ui() {
  return render(
    <ThemeProvider>
      <I18nProvider>
        <ToastProvider>
          <ChatPage />
        </ToastProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// jsdom navigator.language 默认 en-US：钉 zh-CN（产品断言语言，AG-14 白名单键）
localStorage.setItem("helix-lang", "zh-CN");

describe("ChatPage 抽屉接线（P-1 → P-2）", () => {
  it("点击 P-1 卡片打开抽屉并展示该实例；衬底弱化；Esc 关闭复原", () => {
    stateRef.current = play([
      ev({
        v: 0,
        type: "connection.welcome",
        payload: { sessionId: "s1", model: "claude-sonnet-4-5", agentState: "idle" },
      }),
      ev({
        v: 0,
        type: "agent.spawned",
        payload: { agentId: "agent-7", task: "接线验证任务", profileKind: "subagent-worker" },
      }),
    ]);
    ui();
    expect(document.querySelector(".drawer")).toBeNull();
    fireEvent.click(document.querySelector(".sa-card")!);
    const drawer = document.querySelector(".drawer")!;
    expect(drawer.getAttribute("data-instance")).toBe("agent-7");
    expect(subscribeInstance).toHaveBeenCalledWith("agent-7");
    // 衬底弱化（.app[data-drawer="1"]）
    expect(document.querySelector(".app")!.getAttribute("data-drawer")).toBe("1");
    // Esc 关闭：抽屉卸载 + 退订 + 衬底复原
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector(".drawer")).toBeNull();
    expect(unsubscribeInstance).toHaveBeenCalledWith("agent-7");
    expect(document.querySelector(".app")!.getAttribute("data-drawer")).toBeNull();
  });

  it("agent.killed 到达 → kill toast 交代（终止链末端）", () => {
    stateRef.current = play([
      ev({
        v: 0,
        type: "connection.welcome",
        payload: { sessionId: "s1", model: "claude-sonnet-4-5", agentState: "idle" },
      }),
      ev({
        v: 0,
        type: "agent.spawned",
        payload: { agentId: "agent-8", task: "终止链", profileKind: "subagent-worker" },
      }),
      ev({
        v: 0,
        type: "agent.killed",
        payload: {
          agentId: "agent-8",
          closure: { status: "failed", summary: "user terminated", reportPath: null, findings: null, taskId: null },
        },
      }),
    ]);
    ui();
    expect(screen.getByText("实例已终止")).toBeTruthy();
    expect(screen.getByText(/closure 将以 failed 注入主线下轮/)).toBeTruthy();
    expect(consumeKillToast).toHaveBeenCalled();
  });
});
