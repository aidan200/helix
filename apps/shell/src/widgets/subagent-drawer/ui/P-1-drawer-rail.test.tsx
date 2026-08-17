// @vitest-environment jsdom
/**
 * 活跃事件条测试（T5.5；task brief §4.1 —— DrawerRail 重写为活跃事件条）。
 *
 * 行为契约：
 * - 活跃语义：仅 queued+running 上条（data-rail-count = 活跃数，非累计总数）；
 *   终态（done/failed/cancelled）立即离开事件条；无活跃事件 → 条整体隐藏；
 * - 类型注册表渲染：事件标识带类型与着色槽位（subagent → violet）；
 * - 折叠（窄竖条）/展开（简介列表）两态，两态均可开既有抽屉（onOpen）；
 * - localStorage 记忆（helix-activity-rail-collapsed，AG-14 白名单模式）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import type { EventEnvelope } from "@helix/protocol";
import {
  createInitialSessionState,
  sessionReducer,
  type SessionState,
} from "@/entities/session/model/session-reducer";

// ── SessionContext mock（state 注入）──
const stateRef: { current: SessionState } = { current: createInitialSessionState() };
vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return { ...orig, useSession: () => ({ state: stateRef.current }) };
});

import DrawerRail from "./P-1-drawer-rail";

const ev = (event: EventEnvelope) => ({ type: "event", event }) as const;
const play = (events: EventEnvelope[]): SessionState =>
  events.reduce((s, e) => sessionReducer(s, ev(e)), createInitialSessionState());

const welcome: EventEnvelope = {
  v: 0,
  type: "connection.welcome",
  payload: { sessionId: "s1", model: "m", agentState: "idle" },
};
const spawn = (agentId: string): EventEnvelope => ({
  v: 0,
  type: "agent.spawned",
  payload: { agentId, task: `task-${agentId}`, profileKind: "subagent-worker" },
});
const complete = (agentId: string): EventEnvelope => ({
  v: 0,
  type: "agent.completed",
  payload: { agentId, closure: { status: "done", summary: "收口" } },
});
const fail = (agentId: string): EventEnvelope => ({
  v: 0,
  type: "agent.failed",
  payload: { agentId, error: "boom", closure: { status: "failed", summary: "失败" } },
});
const queue = (agentId: string, position: number): EventEnvelope => ({
  v: 0,
  type: "agent.queued",
  payload: { agentId, position },
});

function ui(onOpen: (id: string) => void) {
  return render(
    <I18nProvider>
      <DrawerRail onOpen={onOpen} />
    </I18nProvider>,
  );
}

afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
  // jsdom navigator.language 默认 en-US：钉 zh-CN（产品断言语言，AG-14 白名单键）
  localStorage.setItem("helix-lang", "zh-CN");
});

describe("活跃事件条（T5.5）", () => {
  it("活跃过滤：仅 queued+running 上条（data-rail-count = 活跃数）", () => {
    stateRef.current = play([
      welcome,
      spawn("a-run"),
      spawn("a-queue"),
      queue("a-queue", 1),
      spawn("a-done"),
      complete("a-done"),
      spawn("a-fail"),
      fail("a-fail"),
    ]);
    ui(vi.fn());
    const rail = document.querySelector("[data-drawer-rail]")!;
    expect(rail).not.toBeNull();
    expect(rail.getAttribute("data-rail-count")).toBe("2");
    expect(document.querySelectorAll(".rail-marker")).toHaveLength(2);
  });

  it("终态立即离开事件条；全部终态 → 条整体隐藏", () => {
    stateRef.current = play([welcome, spawn("a1"), complete("a1")]);
    const { container } = ui(vi.fn());
    expect(container.querySelector("[data-drawer-rail]")).toBeNull();
  });

  it("无任何实例 → 不渲染", () => {
    stateRef.current = play([welcome]);
    const { container } = ui(vi.fn());
    expect(container.querySelector("[data-drawer-rail]")).toBeNull();
  });

  it("类型注册表渲染：subagent 事件标识带类型与 violet 着色槽位", () => {
    stateRef.current = play([welcome, spawn("a1")]);
    ui(vi.fn());
    const marker = document.querySelector(".rail-marker")!;
    expect(marker.getAttribute("data-activity-type")).toBe("subagent");
    expect(marker.getAttribute("data-color")).toBe("violet");
  });

  it("折叠态（默认）：点击事件标识开该实例抽屉", () => {
    stateRef.current = play([welcome, spawn("a1"), spawn("a2")]);
    const onOpen = vi.fn();
    ui(onOpen);
    const rail = document.querySelector("[data-drawer-rail]")!;
    expect(rail.getAttribute("data-rail-state")).toBe("collapsed");
    const markers = document.querySelectorAll(".rail-marker");
    fireEvent.click(markers[1]!);
    expect(onOpen).toHaveBeenCalledWith("a2");
  });

  it("展开态：每活跃事件一行简介（名称 + 状态），点击行开抽屉；收起把手回折叠", () => {
    stateRef.current = play([welcome, spawn("a1"), spawn("a2"), queue("a2", 1)]);
    const onOpen = vi.fn();
    ui(onOpen);
    fireEvent.click(screen.getByRole("button", { name: /展开事件条|Expand activity rail/ }));
    const rail = document.querySelector("[data-drawer-rail]")!;
    expect(rail.getAttribute("data-rail-state")).toBe("expanded");
    const rows = document.querySelectorAll(".rail-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("task-a1");
    expect(rows[0]!.textContent).toContain("执行中");
    expect(rows[1]!.textContent).toContain("task-a2");
    expect(rows[1]!.textContent).toContain("排队 #1");
    fireEvent.click(rows[1]!);
    expect(onOpen).toHaveBeenCalledWith("a2");
    fireEvent.click(screen.getByRole("button", { name: /收起事件条|Collapse activity rail/ }));
    expect(document.querySelector("[data-drawer-rail]")!.getAttribute("data-rail-state")).toBe(
      "collapsed",
    );
  });

  it("localStorage 记忆：展开后重挂载恢复展开态", () => {
    stateRef.current = play([welcome, spawn("a1")]);
    ui(vi.fn());
    fireEvent.click(screen.getByRole("button", { name: /展开事件条|Expand activity rail/ }));
    expect(localStorage.getItem("helix-activity-rail-collapsed")).toBe("0");
    cleanup();
    ui(vi.fn());
    expect(document.querySelector("[data-drawer-rail]")!.getAttribute("data-rail-state")).toBe(
      "expanded",
    );
  });
});
