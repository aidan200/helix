// @vitest-environment jsdom
/**
 * 管家面板挂载测试（V2.5 收官批：入口按钮 + 开合接线）。
 *
 * - 入口（顶栏 steward 徽标钮，stats/model 受控同构）渲染：aria-pressed
 *   反映开合态；面板关闭时零渲染；
 * - 点击入口 → StewardPanel 打开（挂载 .wb-main 内 .app 兄弟列——stp
 *   300px 右缘列几何）；
 * - 面板头部 × / Esc → 关闭（StewardPanel 自有链，onClose 回 Workbench
 *   开合态）；再点入口 toggle 关闭。
 *
 * mock 口径沿 ChatPage.test.tsx（WorkspaceContext stub + SessionContext
 * 整面 mock）；steward 命令面 mock 沿 StewardPanel.test.tsx。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ThemeProvider } from "@/shared/ui/theme";
import { ToastProvider } from "@/shared/ui/Toast";
import { createInitialSessionState } from "@/entities/session/model/session-reducer";
import { createInitialTopologyState } from "@/entities/session/model/state";

const sendStewardGetConfig = vi.fn(() => true);
const sendStewardSubscribe = vi.fn(() => true);
const sendStewardUnsubscribe = vi.fn(() => true);
const subscribeStewardFrames = vi.fn(() => () => {});

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
    sendStewardGetConfig,
    sendStewardSubscribe,
    sendStewardUnsubscribe,
    subscribeStewardFrames,
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

// jsdom navigator.language 默认 en-US：钉 zh-CN（AG-14 白名单键）
localStorage.setItem("helix-lang", "zh-CN");

describe("Workbench 管家面板挂载（V2.5 收官批）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => cleanup());

  it("入口渲染（aria-pressed=false）+ 点击打开面板；再点入口 toggle 关闭", () => {
    ui();
    const entry = screen.getByTestId("steward-toggle");
    expect(entry.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("steward-panel")).toBeNull();
    fireEvent.click(entry);
    expect(screen.getByTestId("steward-panel")).toBeTruthy();
    expect(entry.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(entry);
    expect(screen.queryByTestId("steward-panel")).toBeNull();
  });

  it("面板挂载 .wb-main 内 .app 兄弟列；× 与 Esc 关闭（onClose 回开合态）", () => {
    ui();
    fireEvent.click(screen.getByTestId("steward-toggle"));
    const panel = screen.getByTestId("steward-panel");
    const wbMain = document.querySelector(".wb-main")!;
    expect(wbMain).not.toBeNull();
    expect(wbMain.contains(panel)).toBe(true);
    // 兄弟几何：同层存在 .app（面板 = .app 的右缘兄弟列，非 .app 内浮层）
    expect(panel.parentElement!.querySelector(":scope > .app")).not.toBeNull();
    // × 关闭
    fireEvent.click(panel.querySelector(".stp-close")!);
    expect(screen.queryByTestId("steward-panel")).toBeNull();
    // 重开 → Esc 关闭（面板自有窗口级监听）
    fireEvent.click(screen.getByTestId("steward-toggle"));
    expect(screen.getByTestId("steward-panel")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("steward-panel")).toBeNull();
  });
});
