// @vitest-environment jsdom
/**
 * 管家全局常驻测试（管家全局化批：chat 页 top-bar 挂件 → app 壳级能力）。
 *
 * 结构契约：
 * - 入口在 IconRail（app 生命周期常驻壳）——任意路由（含非 chat 路由）可见；
 * - 点击入口 → StewardDock 弹层挂载在 .app-shell 兄弟位（页面域之外，
 *   路由切换不卸载——工作台常驻 DOM 先例同构）；
 * - 面板不侵入页面域：dock 不在 .page-area 内；
 * - 再点入口 toggle 关闭。
 *
 * mock 口径沿 App.gate-hold.test.tsx（useSession/useWorkspace 最小形状 +
 * ChatPage/SettingsPage 桩）+ useAppRoute mock（路由变量注入驱动）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, fireEvent, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { I18nProvider } from "@/shared/i18n";
import { ThemeProvider } from "@/shared/ui/theme";
import { ToastProvider } from "@/shared/ui/Toast";

let route = "/settings";
const navigate = vi.fn((next: string) => {
  route = next;
});
vi.mock("./useAppRoute", () => ({
  useAppRoute: () => ({ route, navigate }),
}));

// 驾驶舱批：switchSession 切页断言面 + steward 帧听众捕获（navigate 帧驱动）
const switchSession = vi.fn();
const stewardListeners = new Set<(e: unknown) => void>();
vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    state: { conn: "connected", connAttempts: 1 },
    topology: { list: [], webStatus: null },
    sendWebStop: () => true,
    sendWebStart: () => true,
    retry: () => {},
    sendStewardGetConfig: () => true,
    sendStewardSubscribe: () => true,
    sendStewardUnsubscribe: () => true,
    switchSession,
    subscribeStewardFrames: (cb: (e: unknown) => void) => {
      stewardListeners.add(cb);
      return () => {
        stewardListeners.delete(cb);
      };
    },
  }),
}));

vi.mock("@/entities/workspace/WorkspaceContext", () => ({
  useWorkspace: () => ({
    state: { phase: "main", current: { root: "/ws/a" }, switching: false },
  }),
}));

vi.mock("@/pages/chat/ChatPage", () => ({
  default: () => <div data-chat-page="on" />,
}));
vi.mock("@/pages/settings/SettingsPage", () => ({
  default: () => <div data-settings-page="on" />,
}));

import { AppRoutes } from "./App";

function ui() {
  return render(
    <ThemeProvider>
      <I18nProvider>
        <ToastProvider>
          <AppRoutes />
        </ToastProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

describe("管家全局常驻（app 壳级能力）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    route = "/settings";
    stewardListeners.clear();
    // jsdom navigator.language 默认 en-US：钉 zh-CN（AG-14 白名单键）
    localStorage.setItem("helix-lang", "zh-CN");
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("非 chat 路由：rail 入口可见 + 点击展开 dock（.app-shell 兄弟位，非页面域；A1：关闭 = 隐藏不卸载）", () => {
    ui();
    const entry = document.querySelector(".rail-steward-btn")! as HTMLButtonElement;
    expect(entry).not.toBeNull();
    expect(entry.getAttribute("aria-pressed")).toBe("false");
    // 非 chat 路由主壳在场（settings 桩）
    const closedDock = document.querySelector("[data-testid=\"steward-dock\"]")!;
    expect(closedDock.className).toContain("stp-dock-hidden"); // A1：隐藏不卸载（组件树保留）

    fireEvent.click(entry!);
    expect(entry!.getAttribute("aria-pressed")).toBe("true");
    const dock = document.querySelector('[data-testid="steward-dock"]')!;
    expect(dock).not.toBeNull();
    expect(dock.className).not.toContain("stp-dock-hidden");
    // 全局位：dock 不在 .page-area（页面域）内——app 壳级弹层
    expect(document.querySelector(".page-area")!.contains(dock)).toBe(false);
    // 内层面板本体在场
    expect(dock.querySelector('[data-testid="steward-panel"]')).not.toBeNull();

    // 再点入口 toggle 关闭（隐藏不卸载——A1）
    fireEvent.click(entry!);
    expect(document.querySelector('[data-testid="steward-dock"]')!.className).toContain("stp-dock-hidden");
    expect(entry!.getAttribute("aria-pressed")).toBe("false");
  });

  it("路由切换不卸载：面板开着导航到另一路由 → dock 仍在（app 生命周期态）", () => {
    ui();
    fireEvent.click(document.querySelector(".rail-steward-btn")!);
    expect(document.querySelector(".stp-dock")).not.toBeNull();
    // 路由切换（mock navigate 变量 + 强制重渲染——真实层 pushState 同构）
    route = "/";
    fireEvent.click(document.querySelector('[data-page="chat"]')!);
    expect(document.querySelector(".stp-dock")).not.toBeNull(); // 常驻不卸载
  });

  it("驾驶舱切页（steward.navigate）：非工作台路由 → 先切回工作台 + switchSession(sessionId)（侧栏同路径）", () => {
    ui();
    expect(stewardListeners.size).toBeGreaterThan(0);
    act(() => {
      for (const l of stewardListeners) {
        l({ type: "steward.navigate", payload: { sessionId: "sess-target" } });
      }
    });
    expect(navigate).toHaveBeenCalledWith("/"); // ROUTE_WORKBENCH
    expect(switchSession).toHaveBeenCalledWith("sess-target");
  });

  it("驾驶舱切页：已在工作台路由 → 零路由导航，仅 switchSession", () => {
    route = "/";
    ui();
    act(() => {
      for (const l of stewardListeners) {
        l({ type: "steward.navigate", payload: { sessionId: "sess-2" } });
      }
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(switchSession).toHaveBeenCalledWith("sess-2");
  });
});
