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
import { afterEach, describe, expect, it, vi } from "vitest";
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

// ── SessionContext mock（state/topology 注入 + setSessionModel 探针）──
const stateRef: { current: SessionState } = { current: createInitialSessionState() };
const topologyRef: { current: TopologyState } = { current: createInitialTopologyState() };
const setSessionModel = vi.fn();
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
      requestModelConfig,
      requestAuthList,
    }),
  };
});

import { TopBarActions } from "./P-1-top-bar";

function catalogModel(id: string): CatalogModel {
  const idx = id.indexOf("/");
  return {
    id,
    providerId: idx > 0 ? id.slice(0, idx) : id,
    contextWindow: 200_000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    source: "builtin",
  };
}

/** 草稿态活跃 store（sessionId===null + view ready + connected）。 */
function draftState(model = ""): SessionState {
  return { ...createInitialSessionState(), conn: "connected", view: "ready", sessionId: null, model };
}

/** 拓扑面：默认模型 + 目录（菜单列表数据源）。 */
function topologyWith(defaultModel: string, models: CatalogModel[]): TopologyState {
  const topo = createInitialTopologyState();
  topo.modelConfig.defaultModel = defaultModel;
  topo.modelConfig.catalog = { models, refreshedAt: 0, source: "builtin", degraded: [] };
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
  });
});
