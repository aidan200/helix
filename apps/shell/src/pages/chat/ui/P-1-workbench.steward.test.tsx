// @vitest-environment jsdom
/**
 * 管家挂件退役回归测试（管家全局化批：chat 页 top-bar 挂件 → IconRail 全局位）。
 *
 * - TopBarActions 不再渲染管家入口（steward-toggle 退役——入口迁 IconRail
 *   管家位，全局性归 App.steward-global.test 钉）；
 * - Workbench 不再挂载 StewardPanel（.wb-main 右缘列退役——弹层归 app 层
 *   StewardDock）；
 * - .wb-main 无 data-steward 让位标记（DrawerRail 回右缘零偏移）。
 *
 * mock 口径沿 ChatPage.test.tsx（WorkspaceContext stub + SessionContext 整面 mock）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ThemeProvider } from "@/shared/ui/theme";
import { ToastProvider } from "@/shared/ui/Toast";
import { createInitialSessionState } from "@/entities/session/model/session-reducer";
import { createInitialTopologyState } from "@/entities/session/model/state";

vi.mock("@/entities/workspace/WorkspaceContext", () => ({
  useWorkspace: () => ({
    state: { phase: "main", current: { root: "/ws/helix" }, switching: false },
    openWorkspace: () => true,
    startSwitch: () => {},
    cancelSwitch: () => {},
  }),
}));
vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    state: createInitialSessionState(),
    topology: {
      ...createInitialTopologyState(),
      active: createInitialSessionState(),
      list: [],
    },
    setDraftMode: vi.fn(),
    requestModelConfig: vi.fn(),
    subscribeWorkspaceFrames: () => () => {}, // W4 刷新链订阅面（无操作 stub）
  }),
}));

import Workbench from "./P-1-workbench";

function ui() {
  return render(
    <ThemeProvider>
      <I18nProvider>
        <ToastProvider>
          <Workbench onOpenInstance={() => undefined}>
            <div className="app" />
          </Workbench>
        </ToastProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

describe("Workbench 管家挂件退役（管家全局化批）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => cleanup());

  it("TopBarActions 零管家入口（steward-toggle 退役）；Workbench 零 StewardPanel 挂载", () => {
    ui();
    expect(document.querySelector('[data-testid="steward-toggle"]')).toBeNull();
    expect(document.querySelector(".steward-toggle")).toBeNull();
    expect(document.querySelector('[data-testid="steward-panel"]')).toBeNull();
    expect(document.querySelector(".stp")).toBeNull();
    expect(document.querySelector(".stp-dock")).toBeNull();
  });

  it(".wb-main 无 data-steward 让位标记（DrawerRail 右缘零偏移回归）", () => {
    ui();
    const wbMain = document.querySelector(".wb-main")!;
    expect(wbMain).not.toBeNull();
    expect(wbMain.getAttribute("data-steward")).toBeNull();
  });
});
