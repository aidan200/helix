// @vitest-environment jsdom
/**
 * P-1 顶栏草稿态模型徽标 + P-3 菜单草稿态可选（T3；bug4）。S1 重构：
 * AppHeader 退役，TopBarActions 为 headerRight 槽内容组件（受控开合，
 * popover 由装配层渲染——本 harness 复刻 Workbench 组合契约）。
 *
 * - 草稿态（sessionId===null && view==="ready" && connected）徽标显示
 *   state.model || topology.modelConfig.defaultModel（两者皆空才不显示）；
 * - 草稿选模（setSessionModel → ui/set-draft-model 本地暂存）后徽标变所选；
 * - 徽标点击 toggle 菜单（受控回调）；菜单在草稿态可 pick（currentModel
 *   回退解析 state.model || mc.defaultModel——选中态/徽标同源）；
 * - 非草稿回归：真实会话徽标语义不变（state.model 空不显示）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { CatalogModel } from "@helix/protocol";
import { I18nProvider } from "@/shared/i18n";
import { ToastProvider } from "@/shared/ui/Toast";
import ModelSwitchMenu from "@/features/model-switch/ui/P-3-model-switch";
import {
  createInitialSessionState,
  type SessionState,
} from "@/entities/session/model/session-reducer";
import {
  createInitialTopologyState,
  type TopologyState,
} from "@/entities/session/model/state";

// ── SessionContext mock（state/topology 注入 + setSessionModel/setDraftMode 探针）──
const stateRef: { current: SessionState } = { current: createInitialSessionState() };
const topologyRef: { current: TopologyState } = { current: createInitialTopologyState() };
const setSessionModel = vi.fn();
const setDraftMode = vi.fn();
const requestModelConfig = vi.fn();
const requestAuthList = vi.fn();
vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({
      state: stateRef.current,
      topology: topologyRef.current,
      setSessionModel,
      setDraftMode,
      requestModelConfig,
      requestAuthList,
    }),
  };
});

// ── WorkspaceContext mock（W4 指示器注入面：current/switching + startSwitch 探针）──
const wsStateRef: { current: { current: { root: string } | null; switching: boolean } } = {
  current: { current: { root: "/Users/siyong/work/helix" }, switching: false },
};
const startSwitch = vi.fn();
vi.mock("@/entities/workspace/WorkspaceContext", () => ({
  useWorkspace: () => ({
    state: wsStateRef.current,
    openWorkspace: () => true,
    startSwitch,
    cancelSwitch: () => {},
  }),
}));

import { TopBarActions, TopBarInfo } from "./P-1-top-bar";

function catalogModel(id: string): CatalogModel {
  const idx = id.indexOf("/");
  return {
    id,
    providerId: idx > 0 ? id.slice(0, idx) : id,
    contextWindow: 200_000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    source: "builtin",
    reasoning: true, // v0.11 additive（thinking 批② 能力位）
    thinkingLevels: ["low", "medium", "high"],
  };
}

/** 草稿态活跃 store（sessionId===null + view ready + connected）。 */
function draftState(model = ""): SessionState {
  return { ...createInitialSessionState(), conn: "connected", view: "ready", sessionId: null, model };
}

/** 拓扑面：默认模型 + 目录（菜单列表数据源）+ 可选 agent 槽位读面。 */
function topologyWith(
  defaultModel: string,
  models: CatalogModel[],
  slots?: { model: string | null; thinking: string | null },
): TopologyState {
  const topo = createInitialTopologyState();
  topo.modelConfig.defaultModel = defaultModel;
  topo.modelConfig.catalog = { models, refreshedAt: 0, source: "builtin", degraded: [] };
  if (slots !== undefined) {
    topo.agentConfig = { revision: 1, slots: { "main-session": slots } };
  }
  return topo;
}

/** 装配 harness：复刻 Workbench 组合契约（受控开合 + popover 由装配层渲染）。 */
function ui() {
  function Harness() {
    const [menuOpen, setMenuOpen] = useState(false);
    return (
      <>
        <TopBarActions
          statsOpen={false}
          modelMenuOpen={menuOpen}
          onToggleStats={() => {}}
          onToggleModelMenu={() => setMenuOpen((v) => !v)}
        />
        {menuOpen && <ModelSwitchMenu onClose={() => setMenuOpen(false)} />}
      </>
    );
  }
  return render(
    <I18nProvider>
      <ToastProvider>
        <Harness />
      </ToastProvider>
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// jsdom navigator.language 默认 en-US：钉 zh-CN（产品断言语言，AG-14 白名单键）
localStorage.setItem("helix-lang", "zh-CN");

describe("P-1 顶栏草稿态模型徽标（T3，bug4）", () => {
  it("草稿态 model 空 → 徽标显示全局默认模型（defaultModel）", () => {
    stateRef.current = draftState("");
    topologyRef.current = topologyWith("anthropic/claude-sonnet-4-5", []);
    ui();
    const badge = document.querySelector("[data-model-badge]");
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain("anthropic/claude-sonnet-4-5");
  });

  it("草稿态选模后（state.model 已暂存）→ 徽标显示所选模型", () => {
    stateRef.current = draftState("openai/gpt-5");
    topologyRef.current = topologyWith("anthropic/claude-sonnet-4-5", []);
    ui();
    const badge = document.querySelector("[data-model-badge]");
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain("openai/gpt-5");
    expect(badge!.textContent).not.toContain("claude-sonnet-4-5");
  });

  it("草稿态 state.model 与 defaultModel 皆空 → 徽标不显示", () => {
    stateRef.current = draftState("");
    topologyRef.current = topologyWith("", []);
    ui();
    expect(document.querySelector("[data-model-badge]")).toBeNull();
  });

  it("草稿态 defaultModel 未加载 → 自动拉取全局默认（fallback 加载链）", () => {
    stateRef.current = draftState("");
    topologyRef.current = topologyWith("", []);
    ui();
    expect(requestModelConfig).toHaveBeenCalled();
  });

  it("草稿态已有展示模型（所选或默认已载）→ 不重复拉取", () => {
    stateRef.current = draftState("openai/gpt-5");
    topologyRef.current = topologyWith("", []);
    ui();
    expect(requestModelConfig).not.toHaveBeenCalled();
  });

  it("非草稿态不主动拉取（回归：拉取归菜单/模型页）", () => {
    stateRef.current = {
      ...createInitialSessionState(),
      conn: "connected",
      view: "ready",
      sessionId: "s1",
      model: "",
    };
    topologyRef.current = topologyWith("", []);
    ui();
    expect(requestModelConfig).not.toHaveBeenCalled();
  });

  it("非草稿回归：真实会话徽标 = state.model；state.model 空不显示", () => {
    stateRef.current = {
      ...createInitialSessionState(),
      conn: "connected",
      view: "ready",
      sessionId: "s1",
      model: "anthropic/claude-sonnet-4-5",
    };
    topologyRef.current = topologyWith("", []);
    const { unmount } = ui();
    expect(document.querySelector("[data-model-badge]")!.textContent).toContain(
      "anthropic/claude-sonnet-4-5",
    );
    unmount();
    stateRef.current = { ...stateRef.current, model: "" };
    ui();
    expect(document.querySelector("[data-model-badge]")).toBeNull();
  });

  it("草稿态徽标点击开菜单 → 菜单可选（pick 调 setSessionModel；默认模型选中态同源）", () => {
    stateRef.current = draftState("");
    topologyRef.current = topologyWith("anthropic/claude-sonnet-4-5", [
      catalogModel("anthropic/claude-sonnet-4-5"),
      catalogModel("openai/gpt-5"),
    ]);
    ui();
    fireEvent.click(document.querySelector("[data-model-badge]")!);
    const menu = document.querySelector("[data-model-menu]");
    expect(menu).not.toBeNull();
    // currentModel 回退解析 state.model || defaultModel → 默认模型项选中态（选中态/徽标同源）
    const defaultItem = document.querySelector('[data-model-item="anthropic/claude-sonnet-4-5"]')!;
    expect(defaultItem.getAttribute("aria-checked")).toBe("true");
    // 菜单在草稿态可 pick：点击目标模型 → setSessionModel（草稿本地暂存链入口）
    fireEvent.click(document.querySelector('[data-model-item="openai/gpt-5"]')!);
    expect(setSessionModel).toHaveBeenCalledWith("openai/gpt-5");
    // T9（B 方案）：选中即关——pick 末尾调 onClose，装配层 menuOpen=false 菜单卸载
    expect(document.querySelector("[data-model-menu]")).toBeNull();
  });

  it("T9（B 方案）：resetToDefault 同样选中即关（setSessionModel(默认) + onClose）", () => {
    stateRef.current = draftState("openai/gpt-5");
    topologyRef.current = topologyWith("anthropic/claude-sonnet-4-5", [
      catalogModel("anthropic/claude-sonnet-4-5"),
      catalogModel("openai/gpt-5"),
    ]);
    ui();
    fireEvent.click(document.querySelector("[data-model-badge]")!);
    // 会话模型 ≠ 全局默认 → 重置入口显示
    const resetBtn = document.querySelector("#btn-model-reset")!;
    expect(resetBtn).not.toBeNull();
    fireEvent.click(resetBtn);
    expect(setSessionModel).toHaveBeenCalledWith("anthropic/claude-sonnet-4-5");
    // 选中即关：菜单卸载（onClose 经装配层置 menuMenuOpen=false）
    expect(document.querySelector("[data-model-menu]")).toBeNull();
  });
});

// ── P1 T4：草稿徽标链三级回退（本地 ?? 槽位 ?? 全局默认）──

describe("P-1 草稿徽标链三级回退（P1 T4：本地暂存 ?? 模式槽位 ?? 全局默认）", () => {
  it("本地暂存空 + 槽位已配 → 徽标显示槽位模型（旧两缀链被槽位遮蔽）", () => {
    stateRef.current = draftState("");
    topologyRef.current = topologyWith(
      "anthropic/claude-sonnet-4-5",
      [],
      { model: "openai/gpt-5", thinking: "high" },
    );
    ui();
    expect(document.querySelector("[data-model-badge]")!.textContent).toContain("openai/gpt-5");
  });

  it("本地暂存优先于槽位（用户手选最高级）", () => {
    stateRef.current = draftState("google/gemini-3-pro");
    topologyRef.current = topologyWith(
      "anthropic/claude-sonnet-4-5",
      [],
      { model: "openai/gpt-5", thinking: null },
    );
    ui();
    expect(document.querySelector("[data-model-badge]")!.textContent).toContain("google/gemini-3-pro");
  });

  it("槽位未拉取（null）→ 回退全局默认（回归：无槽位时旧链不变）", () => {
    stateRef.current = draftState("");
    topologyRef.current = topologyWith("anthropic/claude-sonnet-4-5", []);
    ui();
    expect(document.querySelector("[data-model-badge]")!.textContent).toContain("anthropic/claude-sonnet-4-5");
  });

  it("槽位已拉但未配（model=null）→ 继续回退全局默认", () => {
    stateRef.current = draftState("");
    topologyRef.current = topologyWith(
      "anthropic/claude-sonnet-4-5",
      [],
      { model: null, thinking: null },
    );
    ui();
    expect(document.querySelector("[data-model-badge]")!.textContent).toContain("anthropic/claude-sonnet-4-5");
  });
});

// ── P1 T4：header 模式 chip（草稿可切 / 已建只读）──

function renderTopBarInfo() {
  return render(
    <I18nProvider>
      <TopBarInfo />
    </I18nProvider>,
  );
}

describe("P-1 header 模式 chip（P1 T4：草稿选择器 / 已建只读）", () => {
  it("草稿态：chip 可点（button）+ 显示当前模式显示名 + 点击展开菜单选项 = MODES", () => {
    stateRef.current = draftState();
    topologyRef.current = topologyWith("", []);
    renderTopBarInfo();
    const chip = document.querySelector("[data-mode-chip]")!;
    expect(chip.tagName).toBe("BUTTON");
    expect(chip.textContent).toContain("默认模式"); // chat.mode.default 词条（zh-CN 事实源）
    expect(chip.getAttribute("aria-haspopup")).toBe("menu");
    // 点击展开：选项 = MODES 数据驱动（本期仅 default 一项，选项序同注册表）
    fireEvent.click(chip);
    const menu = document.querySelector("[data-mode-menu]");
    expect(menu).not.toBeNull();
    const items = menu!.querySelectorAll("[data-mode-item]");
    expect(items.length).toBe(1); // MODES.length（P2 增模式零改动断言面）
    expect(items[0]!.getAttribute("aria-checked")).toBe("true"); // 当前项选中
  });

  it("草稿态选模式 → setDraftMode(模式 id)；选中即关（菜单卸载）", () => {
    stateRef.current = draftState();
    topologyRef.current = topologyWith("", []);
    renderTopBarInfo();
    fireEvent.click(document.querySelector("[data-mode-chip]")!);
    fireEvent.click(document.querySelector("[data-mode-item='default']")!);
    expect(setDraftMode).toHaveBeenCalledWith("default");
    expect(document.querySelector("[data-mode-menu]")).toBeNull(); // 选中即关
  });

  it("草稿态点外关闭菜单（不派发动作）", () => {
    stateRef.current = draftState();
    topologyRef.current = topologyWith("", []);
    renderTopBarInfo();
    fireEvent.click(document.querySelector("[data-mode-chip]")!);
    expect(document.querySelector("[data-mode-menu]")).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(document.querySelector("[data-mode-menu]")).toBeNull();
    expect(setDraftMode).not.toHaveBeenCalled();
  });

  it("已建会话：只读显示（span，无菜单交互）", () => {
    stateRef.current = {
      ...createInitialSessionState(),
      conn: "connected",
      view: "ready",
      sessionId: "s1",
      mode: "default",
    };
    topologyRef.current = topologyWith("", []);
    renderTopBarInfo();
    const chip = document.querySelector("[data-mode-chip]")!;
    expect(chip.tagName).toBe("SPAN");
    expect(chip.textContent).toContain("默认模式");
    expect(document.querySelector("[data-mode-menu]")).toBeNull();
  });

  it("~/.helix chip 保留不动（home 词条仍渲染）", () => {
    stateRef.current = draftState();
    topologyRef.current = topologyWith("", []);
    const { unmount } = renderTopBarInfo();
    const home = document.querySelector("[data-home-chip]");
    expect(home).not.toBeNull();
    expect(home!.textContent).toContain("~/.helix");
    // 旧静态 session chip 退役：不再有 chat.header.session 字面渲染
    expect(document.body.textContent).not.toContain("main-session");
    unmount();
  });
});

// ── W4：workspace 指示器（basename/tooltip/切换流/F2 禁用）──

describe("W4 workspace 指示器（top-bar；设计稿 §2.3）", () => {
  beforeEach(() => {
    wsStateRef.current = { current: { root: "/Users/siyong/work/helix" }, switching: false };
    stateRef.current = draftState();
    topologyRef.current = topologyWith("", []);
  });

  it("显示 basename + title 全路径；点击 → startSwitch（直接进入切换流）", () => {
    renderTopBarInfo();
    const chip = document.querySelector("[data-ws-chip]") as HTMLButtonElement;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toBe("helix"); // basename（非全路径）
    expect(chip.getAttribute("title")).toBe("/Users/siyong/work/helix"); // tooltip 全路径
    expect(chip.disabled).toBe(false);
    fireEvent.click(chip);
    expect(startSwitch).toHaveBeenCalledTimes(1);
  });

  it("有活跃 agent → 禁用 + busy 文案 tooltip + 点击无效（F2 裁决）", () => {
    stateRef.current = { ...draftState(), agentState: "running" };
    renderTopBarInfo();
    const chip = document.querySelector("[data-ws-chip]") as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    expect(chip.getAttribute("data-busy")).toBe("1");
    expect(chip.getAttribute("title")).toContain("有智能体运行中");
    expect(chip.getAttribute("title")).toContain("/Users/siyong/work/helix");
    fireEvent.click(chip);
    expect(startSwitch).not.toHaveBeenCalled();
  });

  it("后台会话非 idle → 同禁用（任一会话运行即拒）", () => {
    topologyRef.current = topologyWith("", []);
    topologyRef.current.list.push({
      sessionId: "s-bg",
      title: "后台",
      lastActivityAt: 1,
      runState: "streaming",
      loaded: false,
    });
    renderTopBarInfo();
    expect((document.querySelector("[data-ws-chip]") as HTMLButtonElement).disabled).toBe(true);
  });

  it("未绑定（防御位）→ 不渲染", () => {
    wsStateRef.current = { current: null, switching: false };
    renderTopBarInfo();
    expect(document.querySelector("[data-ws-chip]")).toBeNull();
  });
});
