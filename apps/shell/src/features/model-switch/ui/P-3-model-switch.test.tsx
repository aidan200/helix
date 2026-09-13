// @vitest-environment jsdom
/**
 * P-3 模型切换菜单单测（2026-09-13 事故修复：目录未到达加载空态）。
 *
 * 机械判据：
 * - catalog===null（重启后首拉/重连窗口）→ 加载空态（data-mm-loading）；
 *   列表/搜索空态/零可用空态均不渲染；输入搜索词仍显示加载（与 empty 互斥）；
 * - catalog 到达 + authLoaded 无 configured → 零可用空态（加载态退场）；
 * - catalog 到达 + 有 configured → 分组列表渲染（加载态退场）；
 * - 打开即发 requestModelConfig + requestAuthList（T5.3 数据链不变）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { CatalogModel } from "@helix/protocol";
import { I18nProvider } from "@/shared/i18n";
import { ToastProvider } from "@/shared/ui/Toast";
import {
  createInitialSessionState,
  type SessionState,
} from "@/entities/session/model/session-reducer";
import {
  createInitialTopologyState,
  type TopologyState,
} from "@/entities/session/model/topology";

// ── SessionContext mock（state/topology 注入 + 命令探针；P-1-top-bar 先例）──
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

import ModelSwitchMenu from "./P-3-model-switch";

// 测试语言固定 zh-CN（词条断言基准）
localStorage.setItem("helix-lang", "zh-CN");

function catalogModel(id: string): CatalogModel {
  const idx = id.indexOf("/");
  return {
    id,
    providerId: idx > 0 ? id.slice(0, idx) : id,
    contextWindow: 200_000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    source: "builtin",
    reasoning: false,
    thinkingLevels: [],
  };
}

/** 装配：catalog 三态（null 未到达 / 空目录 / 携带模型）+ auth 凭据面。 */
function setup(opts: {
  catalog: null | CatalogModel[];
  authLoaded?: boolean;
  configured?: string[];
}): void {
  const topo = createInitialTopologyState();
  topologyRef.current = {
    ...topo,
    modelConfig: {
      ...topo.modelConfig,
      catalog:
        opts.catalog === null
          ? null
          : { models: opts.catalog, refreshedAt: 1, source: "builtin", degraded: [] },
      authLoaded: opts.authLoaded ?? false,
      auth: Object.fromEntries(
        (opts.configured ?? []).map((p) => [
          p,
          { providerId: p, configured: true as const, verifyStatus: "unverified" as const },
        ]),
      ),
    },
  };
}

function renderMenu() {
  return render(
    <I18nProvider>
      <ToastProvider>
        <ModelSwitchMenu onClose={() => {}} />
      </ToastProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  stateRef.current = createInitialSessionState();
  vi.clearAllMocks();
});

afterEach(() => cleanup());

describe("目录未到达加载空态（catalog===null；2026-09-13 菜单静默空白事故修复）", () => {
  it("catalog===null → 加载空态；列表/搜索空态/零可用空态均不渲染；打开即拉数据链", () => {
    setup({ catalog: null });
    const { container } = renderMenu();
    expect(container.querySelector("[data-mm-loading]")).not.toBeNull();
    expect(container.querySelector("[data-mm-loading]")!.textContent).toContain("目录加载中");
    expect(container.querySelector("[data-mm-list]")).toBeNull();
    expect(container.querySelector("[data-mm-no-available]")).toBeNull();
    // 搜索零命中空态不渲染（loading 与 empty 互斥——empty 是唯一 data-mm-empty 非 loading 位）
    expect(container.querySelectorAll("[data-mm-empty]").length).toBe(0);
    expect(requestModelConfig).toHaveBeenCalled();
    expect(requestAuthList).toHaveBeenCalled();
  });

  it("catalog===null 且输入搜索词 → 仍加载空态（empty 不抢占）", () => {
    setup({ catalog: null });
    const { container } = renderMenu();
    fireEvent.change(container.querySelector("[data-mm-search]")!, { target: { value: "gpt" } });
    expect(container.querySelector("[data-mm-loading]")).not.toBeNull();
    expect(container.querySelectorAll("[data-mm-empty]").length).toBe(0);
  });

  it("catalog 到达 + 无 configured → 零可用空态（加载态退场）", () => {
    setup({ catalog: [catalogModel("anthropic/claude-a")], authLoaded: true, configured: [] });
    const { container } = renderMenu();
    expect(container.querySelector("[data-mm-loading]")).toBeNull();
    expect(container.querySelector("[data-mm-no-available]")).not.toBeNull();
    expect(container.querySelector("[data-mm-list]")).toBeNull();
  });

  it("catalog 到达 + 有 configured → 分组列表渲染（加载态退场）", () => {
    setup({
      catalog: [catalogModel("anthropic/claude-a"), catalogModel("openai/gpt-a")],
      authLoaded: true,
      configured: ["anthropic"],
    });
    const { container } = renderMenu();
    expect(container.querySelector("[data-mm-loading]")).toBeNull();
    expect(container.querySelector("[data-mm-no-available]")).toBeNull();
    expect(container.querySelectorAll(".mm-group").length).toBe(1); // 仅 configured 分组
    expect(container.querySelectorAll(".mm-item").length).toBe(1);
    expect(container.querySelector("[data-model-item]")!.getAttribute("data-model-item")).toBe("anthropic/claude-a");
  });
});
