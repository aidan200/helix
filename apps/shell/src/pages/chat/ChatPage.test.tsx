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
import { createInitialTopologyState } from "@/entities/session/model/state";

const killInstance = vi.fn();
const subscribeInstance = vi.fn();
const unsubscribeInstance = vi.fn();
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
      // 拓扑面（T3.2 侧栏/顶栏消费面）：活跃即 mock state；modelConfig 为
      // 初始零态（顶栏草稿徽标 fallback 读取 defaultModel）
      topology: {
        ...createInitialTopologyState(),
        active: stateRef.current,
        background: {},
        list: [],
      },
      switchSession,
      newDraft,
      deleteSession,
      requestSessionList,
      requestModelConfig: () => {},
      killInstance,
      subscribeInstance,
      unsubscribeInstance,
      consumeRestoreToast: () => {},
      consumeSpawnToast: () => {},
      consumeKillToast,
    }),
  };
});

import ChatPage from "./ChatPage";

/** S1 壳迁移后的 .app 直系子序断言面（conn-banner → msg-flow → composer-wrap，F 层不变）。 */
function appChildClasses(): string[] {
  return Array.from(document.querySelector(".app")!.children).map(
    (c) => c.className.split(" ")[0] ?? "",
  );
}

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

describe("S1 应用壳统一（AppLayout 迁移）", () => {
  it("chat 页使用 AppLayout 壳：header 全宽置顶 + sidebar 槽 + main 唯一滚动容器；.app 直系子序不变", () => {
    stateRef.current = createInitialSessionState();
    ui();
    const layout = document.querySelector(".app-layout")!;
    expect(Array.from(layout.children).map((c) => c.className)).toEqual([
      "app-header",
      "layout-body",
    ]);
    const body = layout.querySelector(".layout-body")!;
    expect(body.querySelector(".sidebar")).not.toBeNull();
    // .app 落位 main.layout-main；直系子序保持既有断言面
    const main = body.querySelector("main.layout-main")!;
    expect(main.querySelector(".app")).not.toBeNull();
    expect(appChildClasses()).toEqual(["conn-banner", "msg-flow", "composer-wrap"]);
  });

  it("header 槽清理：无 brand / 无主题分段钮 / 无齿轮；scanline 副本删除（归 App.tsx 单份）", () => {
    stateRef.current = createInitialSessionState();
    ui();
    const header = document.querySelector(".app-header")!;
    expect(header.querySelector(".brand, [data-brand-logo]")).toBeNull();
    expect(header.querySelector("#btn-dark, #btn-light, #btn-settings")).toBeNull();
    expect(document.querySelector(".scanline-overlay")).toBeNull();
  });
});
