// @vitest-environment jsdom
/**
 * P-1 顶栏模式 chip 单选项降级（code-review 低危组9）：注册表 MODES 仅
 * 一项时草稿态降级只读 chip（span，无下拉无 aria-haspopup）——单选项
 * 下拉零选择面；P2 增模式（MODES.length>1）后选择器形态由
 * P-1-top-bar.test.tsx（双选项 mock 注册表）覆盖。
 *
 * 本文件用真实 MODES（当前仅 default 一项）——不 mock @helix/protocol；
 * 降级阈值断言面 = MODES.length，注册表增长后本测试应转为多选项形态并
 * 迁回主测试文件。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MODES } from "@helix/protocol";
import { I18nProvider } from "@/shared/i18n";
import {
  createInitialSessionState,
  type SessionState,
} from "@/entities/session/model/session-reducer";
import {
  createInitialTopologyState,
  type TopologyState,
} from "@/entities/session/model/state";

// ── SessionContext mock（草稿态注入 + setDraftMode 探针——主测试文件同构）──
const stateRef: { current: SessionState } = { current: createInitialSessionState() };
const topologyRef: { current: TopologyState } = { current: createInitialTopologyState() };
const setDraftMode = vi.fn();
vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({
      state: stateRef.current,
      topology: topologyRef.current,
      setDraftMode,
    }),
  };
});

// ── WorkspaceContext mock（WorkspaceChip 注入面——主测试文件同构）──
vi.mock("@/entities/workspace/WorkspaceContext", () => ({
  useWorkspace: () => ({
    state: { current: { root: "/Users/siyong/work/helix" }, switching: false },
    openWorkspace: () => true,
    startSwitch: vi.fn(),
    cancelSwitch: () => {},
  }),
}));

import { TopBarInfo } from "./P-1-top-bar";

function renderTopBarInfo() {
  // jsdom navigator.language 默认 en-US：钉 zh-CN（产品断言语言，主测试文件同式）
  localStorage.setItem("helix-lang", "zh-CN");
  return render(
    <I18nProvider>
      <TopBarInfo />
    </I18nProvider>,
  );
}

describe("P-1 header 模式 chip 单选项降级（真实 MODES 注册表）", () => {
  afterEach(() => {
    cleanup();
    setDraftMode.mockClear();
  });

  it.skipIf(MODES.length > 1)("注册表单项：草稿态降级只读 chip（span + 无菜单 + 无 haspopup）", () => {
    expect(MODES.length).toBe(1); // 前提钉住：本测试只在真实注册表单项时生效
    stateRef.current = { ...createInitialSessionState(), conn: "connected", view: "ready", sessionId: null };
    topologyRef.current = createInitialTopologyState();
    renderTopBarInfo();
    const chip = document.querySelector("[data-mode-chip]")!;
    expect(chip.tagName).toBe("SPAN"); // 只读形态（非 button）
    expect(chip.getAttribute("aria-haspopup")).toBeNull();
    expect(chip.textContent).toContain("默认模式"); // 显示名照常（chat.mode.default）
    fireEvent.click(chip); // span 点击零交互：不派发不报错
    expect(document.querySelector("[data-mode-menu]")).toBeNull();
    expect(setDraftMode).not.toHaveBeenCalled();
  });
});
