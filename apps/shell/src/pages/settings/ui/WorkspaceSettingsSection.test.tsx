// @vitest-environment jsdom
/**
 * WorkspaceSettingsSection 组件测试（W4 设置页分区；brief 任务 2 / 验收 3）。
 *
 * 覆盖：当前绑定全路径渲染、切换按钮 → startSwitch、活跃 agent（活跃会话
 * streaming / 后台会话非 idle 两面）→ 按钮禁用 + 文案说明、未绑定防御位。
 * vi.mock useWorkspace + useSession（store 注入分工）；中文断言语言钉 zh-CN。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ThemeProvider } from "@/shared/ui/theme";
import type { WorkspaceState } from "@/entities/workspace/model/workspace-store";

// ── store mock（useWorkspace + useSession 注入面）──────────────
let wsStore: WorkspaceState;
let switchStarted = 0;
/** 会话 store 活跃信号注入位（agentState + topology.list runState；词汇 = AgentStateDto）。 */
let sessionState: {
  agentState: "idle" | "running" | "steering" | "aborting" | "stopped";
  instances: { state: string }[];
};
let listRunStates: string[];

vi.mock("@/entities/workspace/WorkspaceContext", () => ({
  useWorkspace: () => ({
    state: wsStore,
    openWorkspace: () => true,
    startSwitch: () => {
      switchStarted += 1;
    },
    cancelSwitch: () => {},
  }),
}));

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    state: sessionState,
    topology: { list: listRunStates.map((runState, i) => ({ sessionId: `s${i}`, runState })) },
  }),
}));

import WorkspaceSettingsSection from "./WorkspaceSettingsSection";

function bound(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    phase: "main",
    current: { root: "/ws/helix" },
    recents: [],
    notice: null,
    opening: false,
    openError: null,
    switching: false,
    ...overrides,
  };
}

function ui() {
  return render(
    <ThemeProvider>
      <I18nProvider>
        <WorkspaceSettingsSection />
      </I18nProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  wsStore = bound();
  switchStarted = 0;
  sessionState = { agentState: "idle", instances: [] };
  listRunStates = [];
});
afterEach(cleanup);

localStorage.setItem("helix-lang", "zh-CN");

describe("当前绑定展示", () => {
  it("渲染全路径（data-ws-set-root）", () => {
    wsStore = bound({ current: { root: "/Users/siyong/work/helix" } });
    ui();
    const root = document.querySelector("[data-ws-set-root]")!;
    expect(root.textContent).toBe("/Users/siyong/work/helix");
  });

  it("未绑定防御位 → unbound 文案（main 态结构性不可达，防御渲染）", () => {
    wsStore = bound({ current: null });
    ui();
    expect(document.querySelector("[data-ws-set-root]")!.textContent).toContain("未绑定");
  });
});

describe("切换按钮（F2 裁决禁用态）", () => {
  it("空闲态 → 可点，点击 → startSwitch 恰一次", () => {
    ui();
    const btn = document.querySelector("[data-ws-set-switch]") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(switchStarted).toBe(1);
  });

  it("活跃会话运行中（agentState 非 idle）→ 禁用 + 文案说明 + 点击无效", () => {
    sessionState = { agentState: "running", instances: [] };
    ui();
    const btn = document.querySelector("[data-ws-set-switch]") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/存在运行中的会话/)).toBeTruthy();
    fireEvent.click(btn);
    expect(switchStarted).toBe(0);
  });

  it("后台会话非 idle（清单 runState）→ 同禁用（任一会话运行即拒）", () => {
    listRunStates = ["idle", "streaming"];
    ui();
    const btn = document.querySelector("[data-ws-set-switch]") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(document.querySelector("[data-ws-set-busy]")).not.toBeNull();
  });

  it("活跃 SubAgent 实例（instances 非终态）→ 同禁用", () => {
    sessionState = { agentState: "idle", instances: [{ state: "running" }] };
    ui();
    const btn = document.querySelector("[data-ws-set-switch]") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("空闲态 → 无禁用文案区", () => {
    ui();
    expect(document.querySelector("[data-ws-set-busy]")).toBeNull();
  });
});
