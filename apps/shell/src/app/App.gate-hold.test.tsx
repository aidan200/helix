// @vitest-environment jsdom
/**
 * App 门禁首启 hold 测试（W6o；brief 任务 2/3 / 验收 2/3）。
 *
 * 三态钉住：首启在「连接就绪（phase 离开 connecting）且序列播完
 * （挂载起 BOOT_HOLD_MS 兜底）」前恒显 boot 屏（full 形态，即使 phase 已
 * 到 gate/main）；双条件齐备 → firstBootDone 置位放行（gate → 选择页 /
 * main → 主壳 AppRoutes）；此后 phase 回 connecting（重连）→ status 形态
 * 直显，无 hold（防打扰）。fake timers 驱动（vi.advanceTimersByTime），
 * 断言渲染分支而非真实延迟。
 *
 * 供面注入（ProjectPage/WorkspaceGatePage.test 先例）：useWorkspace /
 * useSession 均 mock（store / 会话态可变注入）；ChatPage mock 为轻量桩
 * （AppRoutes 常驻路由位——真实挂载过重且非本测关注面）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { I18nProvider } from "@/shared/i18n";
import { ThemeProvider } from "@/shared/ui/theme";
import { ToastProvider } from "@/shared/ui/Toast";
import type { WorkspaceState } from "@/entities/workspace/model/workspace-store";

// ── useSession mock（WorkspaceBootScreen 活状态行 + AppRoutes web 面最小形状）──
let sessionConn = "connecting";
vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    state: { conn: sessionConn, connAttempts: 1 },
    topology: { list: [], webStatus: null },
    sendWebStop: () => true,
    sendWebStart: () => true,
    retry: () => {},
  }),
}));

// ── useWorkspace mock（store 注入面：phase 可变驱动门禁分支）──
let store: WorkspaceState;
vi.mock("@/entities/workspace/WorkspaceContext", () => ({
  useWorkspace: () => ({ state: store }),
}));

// ── ChatPage 桩（AppRoutes 常驻工作台路由位；主壳在场断言锚点）──
vi.mock("@/pages/chat/ChatPage", () => ({
  default: () => <div data-app-routes="main" />,
}));

import { BOOT_HOLD_MS, WorkspaceGateBranch } from "./App";

function baseState(phase: WorkspaceState["phase"]): WorkspaceState {
  return {
    phase,
    current: phase === "main" ? { root: "/ws/a" } : null,
    recents: [],
    notice: null,
    opening: false,
    openError: null,
    switching: false,
  };
}

let rerenderUi: ((ui: ReactNode) => void) | null = null;
function mount() {
  const r = render(
    <ThemeProvider>
      <I18nProvider>
        <ToastProvider>
          <WorkspaceGateBranch />
        </ToastProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
  rerenderUi = r.rerender;
}

/** 供面重放（phase 变更后强制重读 mock store）。 */
function replay() {
  rerenderUi!(
    <ThemeProvider>
      <I18nProvider>
        <ToastProvider>
          <WorkspaceGateBranch />
        </ToastProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

const bootEl = () => document.querySelector('[data-wsgate-boot="connecting"]');
const mainEl = () => document.querySelector('[data-app-routes="main"]');
const gateEl = () => document.querySelector("[data-wsgate-page='gate']");

beforeEach(() => {
  vi.useFakeTimers();
  sessionConn = "connecting";
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  rerenderUi = null;
});

localStorage.setItem("helix-lang", "zh-CN");

describe("首启 hold（双条件齐备前恒显 full 形态 boot 屏）", () => {
  it("phase=main 但序列未播完 → 仍渲染 boot 屏（full：16 行），主壳不渲染", () => {
    store = baseState("main");
    mount();
    // 连接已就绪（phase 已离 connecting）但序列未播完 → hold
    expect(bootEl()).not.toBeNull();
    expect(bootEl()!.querySelectorAll(".bl")).toHaveLength(16);
    expect(mainEl()).toBeNull();
    // 前进一半仍未放行（~1.4s 兜底内）
    act(() => vi.advanceTimersByTime(BOOT_HOLD_MS / 2));
    expect(bootEl()).not.toBeNull();
    expect(mainEl()).toBeNull();
  });

  it("序列播完 + phase=main → 放行主壳（AppRoutes），boot 屏卸载", () => {
    store = baseState("main");
    mount();
    act(() => vi.advanceTimersByTime(BOOT_HOLD_MS));
    expect(mainEl()).not.toBeNull();
    expect(bootEl()).toBeNull();
  });

  it("序列播完但 phase 仍 connecting → 继续显 boot 屏（连接就绪才放行）", () => {
    store = baseState("connecting");
    mount();
    act(() => vi.advanceTimersByTime(BOOT_HOLD_MS));
    expect(bootEl()).not.toBeNull();
    expect(mainEl()).toBeNull();
    // 连接就绪到达（get-result → main）→ 放行
    store = baseState("main");
    replay();
    expect(mainEl()).not.toBeNull();
    expect(bootEl()).toBeNull();
  });

  it("首启进 gate（选择页）同受 hold：播完才见选择页（开场体验统一）", () => {
    store = baseState("gate");
    mount();
    expect(bootEl()).not.toBeNull();
    expect(bootEl()!.querySelectorAll(".bl")).toHaveLength(16); // full 形态
    expect(gateEl()).toBeNull();
    act(() => vi.advanceTimersByTime(BOOT_HOLD_MS));
    expect(gateEl()).not.toBeNull();
    expect(bootEl()).toBeNull();
  });
});

describe("firstBootDone 后重连（phase 回 connecting）→ status 形态直显", () => {
  it("首启完成后 phase 回 connecting → 仅活状态行（无 hold、不重播序列）", () => {
    store = baseState("main");
    mount();
    act(() => vi.advanceTimersByTime(BOOT_HOLD_MS));
    expect(mainEl()).not.toBeNull();
    // 重连：phase 回 connecting → status 形态（1 行活状态），立即在场（无 hold）
    store = baseState("connecting");
    replay();
    expect(bootEl()).not.toBeNull();
    expect(bootEl()!.querySelectorAll(".bl")).toHaveLength(1);
    expect(bootEl()!.querySelector(".boot-cursor")).not.toBeNull();
    expect(mainEl()).toBeNull();
    // 重连期不再 hold：时间推进不改变 status 形态（firstBootDone 恒置）
    act(() => vi.advanceTimersByTime(BOOT_HOLD_MS));
    expect(bootEl()!.querySelectorAll(".bl")).toHaveLength(1);
    // 恢复 → 回主壳
    store = baseState("main");
    replay();
    expect(mainEl()).not.toBeNull();
    expect(bootEl()).toBeNull();
  });
});
