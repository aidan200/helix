// @vitest-environment jsdom
/**
 * P-2 会话侧栏单测（F(1.2).1 草稿 / F(1.2).4 删除确认互斥；T3.2）。
 *
 * 侧栏数据面经 SessionContext mock 注入（topology.list / background /
 * active）；断言：草稿卡片可见性（connected + sessionId null）、删除
 * confirming 单值互斥（进入前清他卡）、删活跃会话走 deleteSession、
 * 新建草稿走 newDraft（零 daemon 帧归 provider 面此处只断言调用）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ThemeProvider } from "@/shared/ui/theme";
import { ToastProvider } from "@/shared/ui/Toast";
import type { SessionMeta } from "@helix/protocol";
import { createInitialSessionState, sessionReducer, type SessionState } from "@/entities/session/model/session-reducer";
import { createInitialModelConfigState } from "@/entities/session/model/state";
import type { TopologyState } from "@/entities/session/model/topology";

const switchSession = vi.fn();
const newDraft = vi.fn();
const deleteSession = vi.fn();
const requestSessionList = vi.fn();

function makeState(sessionId: string | null, agentState: "idle" | "running" = "idle"): SessionState {
  const s = sessionReducer(
    createInitialSessionState(),
    ({
      type: "event",
      event: {
        v: 0,
        type: "connection.welcome",
        payload: { sessionId, model: "claude-sonnet-4-5", agentState },
      },
    }) as Parameters<typeof sessionReducer>[1],
  );
  return { ...s, conn: "connected" };
}

const LIST: SessionMeta[] = [
  { sessionId: "s1", title: "修复调度器竞态问题", lastActivityAt: 9_000, runState: "streaming", loaded: true },
  { sessionId: "s2", title: "重构事件分发架构", lastActivityAt: 5_000, runState: "idle", loaded: false },
];

let topologyRef: { current: TopologyState } = { current: null as unknown as TopologyState };
let stateRef: { current: SessionState } = { current: null as unknown as SessionState };

vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({
      state: stateRef.current,
      topology: topologyRef.current,
      switchSession,
      newDraft,
      deleteSession,
      requestSessionList,
      killInstance: vi.fn(),
      subscribeInstance: vi.fn(),
      unsubscribeInstance: vi.fn(),
      devDispatchEvent: vi.fn(),
      consumeRestoreToast: () => {},
      consumeSpawnToast: () => {},
      consumeKillToast: () => {},
    }),
  };
});

import SessionSidebar from "./P-2-session-sidebar";

function ui() {
  return render(
    <ThemeProvider>
      <I18nProvider>
        <ToastProvider>
          <SessionSidebar />
        </ToastProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

localStorage.setItem("helix-lang", "zh-CN");

describe("P-2 会话侧栏", () => {
  it("活跃会话态：无草稿卡；清单卡片按序渲染（标题/运行态/时间档位）+ connected 触发清单拉取", () => {
    stateRef.current = makeState("s1", "running");
    topologyRef.current = {
      active: stateRef.current,
      background: { s2: { sessionId: "s2", title: LIST[1]!.title, runState: "idle", lastActivityAt: 5_000, unread: 3 } },
      list: LIST,
      modelConfig: createInitialModelConfigState(),
    };
    ui();
    expect(screen.queryByTestId("draft")).toBeNull();
    const s1 = screen.getAllByText("修复调度器竞态问题")[0]!.closest("[data-session-card]");
    expect(s1!.getAttribute("data-active")).toBe("1");
    expect(s1!.getAttribute("data-run-state")).toBe("streaming");
    const s2 = screen.getAllByText("重构事件分发架构")[0]!.closest("[data-session-card]");
    expect(s2!.getAttribute("data-unread")).toBe("3");
    expect(s2!.getAttribute("data-run-state")).toBe("idle");
    expect(requestSessionList).toHaveBeenCalledTimes(1);
  });

  it("草稿态（sessionId=null + connected）：草稿卡在顶 + 新建按钮走 newDraft", () => {
    stateRef.current = makeState(null);
    topologyRef.current = { active: stateRef.current, background: {}, list: [], modelConfig: createInitialModelConfigState() };
    ui();
    const draft = document.querySelector('[data-session-card="draft"]');
    expect(draft).not.toBeNull();
    expect(draft!.textContent).toContain("草稿");
    fireEvent.click(screen.getByText("新建会话"));
    expect(newDraft).toHaveBeenCalledTimes(1);
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("删除二次确认：trash 进入 confirming（单值互斥——另一卡进入时前卡退出）；取消复原", () => {
    stateRef.current = makeState("s1");
    topologyRef.current = { active: stateRef.current, background: {}, list: LIST, modelConfig: createInitialModelConfigState() };
    ui();
    const cards = screen.getAllByText("修复调度器竞态问题")[0]!.closest("[data-session-card]")!;
    const card2 = screen.getAllByText("重构事件分发架构")[0]!.closest("[data-session-card]")!;
    fireEvent.click(cards.querySelector(".ses-del")!);
    expect(cards.getAttribute("data-confirming")).toBe("1");
    expect(cards.querySelector(".ses-confirm")!.getBoundingClientRect).toBeTruthy();
    // 第二张卡进入 confirming → 第一张退出（一次仅一张卡）
    fireEvent.click(card2.querySelector(".ses-del")!);
    expect(cards.hasAttribute("data-confirming")).toBe(false);
    expect(card2.getAttribute("data-confirming")).toBe("1");
    // 取消复原
    fireEvent.click(card2.querySelector("[data-del-cancel]")!);
    expect(card2.hasAttribute("data-confirming")).toBe(false);
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("确认删除：发 deleteSession（活跃会话同链——切草稿归 provider 面）；折叠记忆写入 localStorage", () => {
    stateRef.current = makeState("s1");
    topologyRef.current = { active: stateRef.current, background: {}, list: LIST, modelConfig: createInitialModelConfigState() };
    ui();
    const card = screen.getAllByText("修复调度器竞态问题")[0]!.closest("[data-session-card]")!;
    fireEvent.click(card.querySelector(".ses-del")!);
    fireEvent.click(card.querySelector("[data-del-confirm]")!);
    expect(deleteSession).toHaveBeenCalledWith("s1");
    expect(card.hasAttribute("data-confirming")).toBe(false); // 确认后退出 confirming

    // 折叠（F(2.1).2）：icon 条 + localStorage 记忆（白名单键）
    localStorage.removeItem("helix-sidebar-collapsed");
    fireEvent.click(screen.getByTitle("折叠侧栏"));
    expect(document.querySelector(".sidebar")!.getAttribute("data-collapsed")).toBe("1");
    expect(localStorage.getItem("helix-sidebar-collapsed")).toBe("1");
    // 折叠态图标条：新建入口 + 每会话状态点入口在场
    expect(screen.getByTitle("新建会话")).toBeTruthy();
  });
});
