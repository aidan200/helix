// @vitest-environment jsdom
/**
 * TraceSidebar 管家合成入口组件测试（fix/trace-steward-entry 批）。
 *
 * 断言面：合成条目渲染（会话 tab 顶部固定，i18n 词条 + 图标）、选中态
 * （sessionId=SYSTEM_SESSION_ID → on/aria-pressed）、点击回调
 * （onSelectSession(SYSTEM_SESSION_ID)）、计数口径（普通条目数 = 真实会话数，
 * 合成条目不带 data-session-id）、零会话空态下固定条目仍在。
 * 纯展示组件（TR-AD-8）——props 直注，mock 面仅 I18nProvider。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { SYSTEM_SESSION_ID } from "@helix/protocol";
import TraceSidebar, { type TraceSidebarProps } from "./TraceSidebar";

// jsdom navigator.language 默认 en-US：钉 zh-CN（产品断言语言，TracePage.test 先例）
localStorage.setItem("helix-lang", "zh-CN");

const SESSIONS = [
  { sessionId: "ses_a", title: "会话 A", lastActivityAt: 2, runState: "idle" as const, loaded: true },
  { sessionId: "ses_b", title: "会话 B", lastActivityAt: 1, runState: "idle" as const, loaded: true },
];

function renderSidebar(over: Partial<TraceSidebarProps> = {}) {
  const onSelectSession = vi.fn();
  const props = {
    taskSessions: [] as typeof SESSIONS,
    sessions: SESSIONS,
    sessionId: "ses_a",
    instances: [],
    selectedInstance: null,
    loading: false,
    refMs: Date.parse("2026-09-21T10:00:00.000Z"),
    onSelectSession,
    onSelectInstance: vi.fn(),
    ...over,
  };
  const view = render(
    <I18nProvider>
      <TraceSidebar {...props} />
    </I18nProvider>,
  );
  return { onSelectSession, ...view };
}

afterEach(cleanup);

describe("TraceSidebar 管家合成入口", () => {
  it("会话 tab 顶部固定渲染「管家 · 常驻」合成条目（先于普通会话行）", () => {
    const { container } = renderSidebar();
    const entry = screen.getByText("管家 · 常驻").closest("button");
    expect(entry).not.toBeNull();
    expect(entry!.getAttribute("data-steward-entry")).toBe("true");
    // 顶部固定：tsb-list 内首个 button 且先于首个普通会话行
    const list = container.querySelector(".tsb-list")!;
    const firstBtn = list.querySelector("button");
    expect(firstBtn).toBe(entry);
    expect(firstBtn!.querySelector("[data-session-id]")).toBeNull(); // 合成条目无会话 id 尾巴
  });

  it("选中态：sessionId=SYSTEM_SESSION_ID → on 类 + aria-pressed", () => {
    const { container } = renderSidebar({ sessionId: SYSTEM_SESSION_ID });
    const entry = container.querySelector("[data-steward-entry]")!;
    expect(entry.getAttribute("aria-pressed")).toBe("true");
    expect(entry.className).toContain("on");
    // 跨条目互斥：普通会话行不再选中
    const sesA = container.querySelector('[data-session-id="ses_a"]')!;
    expect(sesA.getAttribute("aria-pressed")).toBe("false");
  });

  it("未选中态：aria-pressed=false", () => {
    const { container } = renderSidebar({ sessionId: "ses_a" });
    const entry = container.querySelector("[data-steward-entry]")!;
    expect(entry.getAttribute("aria-pressed")).toBe("false");
    expect(entry.className).not.toContain("on");
  });

  it("点击 → onSelectSession(SYSTEM_SESSION_ID)", () => {
    const { container, onSelectSession } = renderSidebar();
    fireEvent.click(container.querySelector("[data-steward-entry]")!);
    expect(onSelectSession).toHaveBeenCalledWith(SYSTEM_SESSION_ID);
    expect(onSelectSession).toHaveBeenCalledTimes(1);
  });

  it("计数口径：普通条目数 = 真实会话数（合成条目不带 data-session-id）", () => {
    const { container } = renderSidebar();
    expect(container.querySelectorAll("[data-session-id]")).toHaveLength(2);
  });

  it("零会话空态：合成条目仍渲染（固定入口）+ 空态文案", () => {
    const { container } = renderSidebar({ sessions: [] });
    expect(screen.getByText("管家 · 常驻")).toBeTruthy();
    expect(screen.getByText("暂无会话")).toBeTruthy();
    expect(container.querySelectorAll("[data-session-id]")).toHaveLength(0);
  });

  it("任务 tab 激活时合成条目不出现（入口属于会话 tab）", () => {
    const { container } = renderSidebar({
      taskSessions: [{ sessionId: "task:j1", title: "任务一", lastActivityAt: 3, runState: "subagent_running" as const, loaded: false }],
    });
    fireEvent.click(screen.getByRole("tab", { name: "任务" }));
    expect(container.querySelector("[data-steward-entry]")).toBeNull();
    // 切回会话 tab 恢复
    fireEvent.click(screen.getByRole("tab", { name: "会话" }));
    expect(container.querySelector("[data-steward-entry]")).not.toBeNull();
  });

  it("选中管家时下分区实例面板照常渲染（sessionId 非空判空）", () => {
    const { container } = renderSidebar({
      sessionId: SYSTEM_SESSION_ID,
      instances: [
        {
          instanceId: "steward",
          agentKind: "subagent",
          profileKind: "steward",
          status: "running",
          startedAt: "2026-09-21T09:00:00.000Z",
          eventCount: 8,
          snapshotMissing: true,
        },
      ],
    });
    const panel = container.querySelector(".inst-panel");
    expect(panel).not.toBeNull();
    expect(within(panel as HTMLElement).getByText("管家")).toBeTruthy(); // stewardName 注入
  });
});
