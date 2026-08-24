// @vitest-environment jsdom
/**
 * ComposerThinkingPicker 单测（P-1 composer 推理强度滑块；thinking 批 T2.1；
 * review.md §2 必须还原 1/2/5/6/7 + F1.1 命令链）。
 *
 * 机械判据（默认关语义后：AUTO 退场，OFF = UI 合成第 0 刻度）：
 * - trigger chip：THINKING 微标 + accent 生效档大写 + chevron；aria-expanded 同步；
 *   无覆盖（effective=null，默认关）与显式关（override=off）同态显示 OFF；
 * - popover 开合：trigger 点击切换 / 外部 pointerdown 关闭 / Escape 关闭；
 * - 选档 → setSessionThinking(level)（SessionContext 侧仿 setSessionModel 发
 *   thinkingSetCommand；命令载荷断言归 commands.test.ts）；
 * - 能力位三变体：六档/三档刻度 = thinkingLevels.length + 1（off 第 0 刻度）；
 *   reasoning=false →
 *   trigger 禁用 + 说明取代滑块位（滑块不渲染，两态不叠加）；目录未到达 →
 *   加载提示位（与滑块/说明互斥）；
 * - 覆盖 vs 生效分离（F1.3）：override≠effective → warning 轻提示
 *   「xhigh → high（模型能力所限）」；一致时无提示（重渲染清旧提示）；
 * - PEAK（F1.4）：effective=最高档 → trigger + popover 同入 .peak + 徽章；
 *   三档模型 high 同触发；
 * - 负断言：无「关闭 reasoning」入口；原型标注文字不存在（剥离验收）；
 * - fresh-load 回归（T2.1 打回修复）：握手前挂载（conn=connecting）不发目录
 *   请求；conn 迁移 connected 后效应补拉（目录帧必达）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { CatalogModel } from "@helix/protocol";
import { I18nProvider } from "@/shared/i18n";
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
const setSessionThinking = vi.fn();
const requestModelConfig = vi.fn();
vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({
      state: stateRef.current,
      topology: topologyRef.current,
      setSessionThinking,
      requestModelConfig,
    }),
  };
});

import ComposerThinkingPicker from "./ComposerThinkingPicker";

// 测试语言固定 zh-CN（词条断言基准；detectLang 读 localStorage 优先）
localStorage.setItem("helix-lang", "zh-CN");

const SIX = ["minimal", "low", "medium", "high", "xhigh", "max"];
const TRI = ["low", "medium", "high"];

function catalogModel(id: string, reasoning: boolean, thinkingLevels: string[]): CatalogModel {
  const idx = id.indexOf("/");
  return {
    id,
    providerId: idx > 0 ? id.slice(0, idx) : id,
    contextWindow: 200_000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    source: "builtin",
    reasoning,
    thinkingLevels,
  };
}

/** 装配基态：真实会话 + 目录携带指定能力位模型 + thinking 切片。 */
function setup(opts: {
  levels?: string[];
  reasoning?: boolean;
  override?: string | null;
  effective?: string | null;
  noCatalog?: boolean;
} = {}) {
  const { levels = SIX, reasoning = true, override = null, effective = "medium", noCatalog = false } = opts;
  stateRef.current = {
    ...createInitialSessionState(),
    conn: "connected",
    view: "ready",
    sessionId: "s1",
    model: "anthropic/claude-opus-4.1",
    thinking: { override, effective },
  };
  const topo = createInitialTopologyState();
  if (!noCatalog) {
    topo.modelConfig.catalog = {
      models: [catalogModel("anthropic/claude-opus-4.1", reasoning, levels)],
      refreshedAt: 0,
      source: "builtin",
      degraded: [],
    };
  }
  topologyRef.current = topo;
  return render(
    <I18nProvider>
      <ComposerThinkingPicker />
    </I18nProvider>,
  );
}

const trigger = () => document.querySelector<HTMLButtonElement>(".tp-trigger")!;
const popover = () => document.querySelector<HTMLElement>(".tp-popover");

beforeEach(() => {
  setSessionThinking.mockClear();
  requestModelConfig.mockClear();
});
afterEach(cleanup);

describe("ComposerThinkingPicker · trigger chip 落位与显示（review §2-1）", () => {
  it("24px trigger：THINKING 微标 + accent 生效档大写 + chevron；aria-haspopup/expanded", () => {
    setup({ effective: "high" });
    const t = trigger();
    expect(t.querySelector(".tp-label")!.textContent).toBe("THINKING");
    expect(t.querySelector(".tp-level")!.textContent).toBe("HIGH");
    expect(t.querySelector(".tp-chev")).not.toBeNull();
    expect(t.getAttribute("aria-expanded")).toBe("false");
    expect(t.disabled).toBe(false);
  });

  it("挂载即拉目录（requestModelConfig 未请求态才发，重复打开零重发归 provider）", () => {
    setup();
    expect(requestModelConfig).toHaveBeenCalled();
  });

  it("fresh-load 回归：握手前挂载（conn=connecting）不发；conn 迁移 connected 后补拉", () => {
    // app 首渲染早于 WS 握手——握手前发送被 HelixWsClient 静默拒绝且无重试，
    // 故连接前效应不得发；握手完成（conn → connected）后效应重发补拉
    stateRef.current = {
      ...createInitialSessionState(),
      conn: "connecting",
      view: "ready",
      sessionId: "s1",
      model: "anthropic/claude-opus-4.1",
      thinking: { override: null, effective: "medium" },
    };
    topologyRef.current = createInitialTopologyState();
    const view = render(
      <I18nProvider>
        <ComposerThinkingPicker />
      </I18nProvider>,
    );
    expect(requestModelConfig).not.toHaveBeenCalled();
    stateRef.current = { ...stateRef.current, conn: "connected" };
    view.rerender(
      <I18nProvider>
        <ComposerThinkingPicker />
      </I18nProvider>,
    );
    expect(requestModelConfig).toHaveBeenCalled();
  });

  it("无覆盖且生效 null（默认关）→ 显示 OFF；reasoning=false → OFF + 禁用态", () => {
    // 默认关语义：无覆盖（effective=null）与显式关同态 OFF——AUTO 文案退场
    setup({ effective: null });
    expect(trigger().querySelector(".tp-level")!.textContent).toBe("OFF");
    cleanup();
    setup({ reasoning: false, levels: [], effective: null });
    const t = trigger();
    // 禁用态 = aria-disabled + 视觉禁用 class（trigger 仍可点开——popover 内
    // 禁用说明是用户撞上状态时的必要交代；disabled 属性会锁死 popover 使说明
    // 成死代码，故禁用语义落在 aria + 样式，滑块交互面整体不渲染）
    expect(t.getAttribute("aria-disabled")).toBe("true");
    expect(t.classList.contains("disabled")).toBe(true);
    expect(t.querySelector(".tp-level")!.textContent).toBe("OFF");
  });
});

describe("ComposerThinkingPicker · popover 开合（F1.1 交互）", () => {
  it("trigger 点击切换开合 + aria-expanded 同步；点外 pointerdown 与 Escape 关闭", () => {
    setup();
    fireEvent.click(trigger());
    expect(popover()).not.toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    // popover 结构：section-label（scope 文字提示行已删——用户决策 2026-08-24）
    expect(popover()!.querySelector(".tp-title")!.textContent).toBe("Reasoning Effort");
    expect(popover()!.querySelector(".tp-scope")).toBeNull();
    expect(popover()!.textContent).not.toContain("会话覆盖");
    fireEvent.click(trigger());
    expect(popover()).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    // 外部 pointerdown 关闭
    fireEvent.click(trigger());
    fireEvent.pointerDown(document.body);
    expect(popover()).toBeNull();
    // Escape 关闭
    fireEvent.click(trigger());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(popover()).toBeNull();
  });
});

describe("ComposerThinkingPicker · 能力位驱动渲染（F1.2 / §2.7 三变体）", () => {
  it("六档变体：滑块 7 刻度（off + 六档）；三档变体：4 刻度", () => {
    setup({ levels: SIX });
    fireEvent.click(trigger());
    expect(document.querySelectorAll(".tl-tick")).toHaveLength(7);
    cleanup();
    setup({ levels: TRI, effective: "high" });
    fireEvent.click(trigger());
    expect(document.querySelectorAll(".tl-tick")).toHaveLength(4);
  });

  it("reasoning=false：popover 内说明取代滑块位（滑块不渲染，两态不叠加）", () => {
    setup({ reasoning: false, levels: [], effective: null });
    fireEvent.click(trigger()); // trigger 禁用态但可点开——说明是用户必要交代
    const pop = popover()!;
    expect(pop.textContent).toContain("当前模型不支持 reasoning");
    expect(pop.querySelector(".tl-track")).toBeNull(); // 滑块不渲染
    expect(pop.querySelector(".tp-disabled-note")).not.toBeNull();
  });

  it("目录未到达：加载提示位（与滑块/禁用说明互斥）", () => {
    setup({ noCatalog: true });
    fireEvent.click(trigger());
    const pop = popover()!;
    expect(pop.textContent).toContain("正在获取模型能力信息");
    expect(pop.querySelector(".tl-track")).toBeNull();
    expect(pop.querySelector(".tp-disabled-note")).toBeNull();
  });
});

describe("ComposerThinkingPicker · OFF 第 0 刻度（默认关语义）", () => {
  it("滑块第 0 刻度为 off；无覆盖 ghost 空心 thumb 停 off 位", () => {
    setup({ override: null, effective: null });
    fireEvent.click(trigger());
    const ticks = document.querySelectorAll(".tl-tick");
    expect(ticks[0]!.getAttribute("data-level")).toBe("off");
    expect(ticks[0]!.textContent).toBe("off");
    // 无覆盖 = ghost 空心 thumb 停 off 位（刻度去强调）；区别于显式关的实心 thumb
    const thumb = document.querySelector<HTMLElement>(".tl-thumb")!;
    expect(thumb.classList.contains("ghost")).toBe(true);
    expect(thumb.style.left).toBe("0%");
  });

  it("选 OFF 刻度 → setSessionThinking 收到 \"off\"（协议透传，daemon 侧短路）", () => {
    setup({ effective: "medium" });
    fireEvent.click(trigger());
    fireEvent.click(document.querySelector<HTMLButtonElement>('.tl-tick[data-level="off"]')!);
    expect(setSessionThinking).toHaveBeenCalledWith("off");
  });

  it("显式关（override=off 生效）→ 实心 thumb 停 off 位；非 ghost", () => {
    setup({ override: "off", effective: "off" });
    fireEvent.click(trigger());
    expect(trigger().querySelector(".tp-level")!.textContent).toBe("OFF");
    const thumb = document.querySelector<HTMLElement>(".tl-thumb")!;
    expect(thumb.classList.contains("ghost")).toBe(false);
    expect(thumb.style.left).toBe("0%");
    expect(document.querySelector(".tl-tick.cur")!.textContent).toBe("off");
  });
});

describe("ComposerThinkingPicker · 选档命令链（F1.1）", () => {
  it("点刻度 → setSessionThinking(level)（SessionContext 发 thinkingSetCommand）", () => {
    setup();
    fireEvent.click(trigger());
    fireEvent.click(document.querySelector<HTMLButtonElement>('.tl-tick[data-level="xhigh"]')!);
    expect(setSessionThinking).toHaveBeenCalledWith("xhigh");
  });
});

describe("ComposerThinkingPicker · 覆盖 vs 生效分离（F1.3）", () => {
  it("override≠effective → warning 轻提示「xhigh → high（模型能力所限）」；滑块强调 = effective", () => {
    setup({ override: "xhigh", effective: "high" });
    fireEvent.click(trigger());
    const hint = document.querySelector<HTMLElement>(".tp-hint")!;
    expect(hint.textContent).toBe("xhigh → high（模型能力所限）");
    // 滑块位置/强调 = 生效档 high（off+六档序列 idx 4/6 = 4/6*100%）
    expect(document.querySelector<HTMLElement>(".tl-thumb")!.style.left).toBe(`${(4 / 6) * 100}%`);
    expect(document.querySelector('.tl-tick.cur')!.textContent).toBe("high");
  });

  it("重渲染清旧提示：override==effective 后 hint 消失", () => {
    const view = setup({ override: "xhigh", effective: "high" });
    fireEvent.click(trigger());
    expect(document.querySelector(".tp-hint")).not.toBeNull();
    stateRef.current = { ...stateRef.current, thinking: { override: "high", effective: "high" } };
    view.rerender(
      <I18nProvider>
        <ComposerThinkingPicker />
      </I18nProvider>,
    );
    expect(document.querySelector(".tp-hint")).toBeNull();
  });
});

describe("ComposerThinkingPicker · PEAK 态（F1.4）", () => {
  it("effective=最高档 → trigger + popover 同入 .peak + 「▲ PEAK」徽章", () => {
    setup({ levels: SIX, override: "max", effective: "max" });
    expect(trigger().classList.contains("peak")).toBe(true);
    fireEvent.click(trigger());
    const pop = popover()!;
    expect(pop.classList.contains("peak")).toBe(true);
    expect(pop.querySelector(".tp-peak-badge")!.textContent).toContain("PEAK");
    expect(document.querySelector(".tl-track")!.classList.contains("peak")).toBe(true);
  });

  it("三档模型最高档 high 同触发 PEAK；非最高档不触发", () => {
    setup({ levels: TRI, override: "high", effective: "high" });
    expect(trigger().classList.contains("peak")).toBe(true);
    cleanup();
    setup({ levels: TRI, override: "medium", effective: "medium" });
    expect(trigger().classList.contains("peak")).toBe(false);
  });
});

describe("ComposerThinkingPicker · 负断言", () => {
  it("无「关闭 reasoning」入口；原型标注文字剥离（PROTO/模拟/localStorage 不存在）", () => {
    setup();
    fireEvent.click(trigger());
    const all = document.body.textContent ?? "";
    expect(all).not.toContain("关闭 reasoning");
    expect(all).not.toContain("关闭推理");
    expect(all).not.toContain("模拟 model.set");
    expect(all).not.toContain("PROTO");
    expect(all).not.toContain("localStorage");
    expect(document.querySelector("[data-proto-annotation]")).toBeNull();
  });
});

// ── P1 T4：草稿基准换源（刻度/显示基准 = 当前模式槽位模型能力位；显示值 = 本地暂存 ?? 槽位 thinking ?? 默认关）──

/** 草稿装配：目录双模型（opus 六档 / gpt-5 三档）+ 全局默认 opus + 可选槽位读面。 */
function draftSetup(opts: {
  slot?: { model: string | null; thinking: string | null } | null;
  model?: string;
  override?: string | null;
  effective?: string | null;
} = {}) {
  const { slot = null, model = "", override = null, effective = null } = opts;
  stateRef.current = {
    ...createInitialSessionState(),
    conn: "connected",
    view: "ready",
    sessionId: null, // 草稿态（P1 T4 基准换源门控）
    mode: "default",
    model, // 本地暂存所选（空串 = 未选）
    thinking: { override, effective },
  };
  const topo = createInitialTopologyState();
  topo.modelConfig.defaultModel = "anthropic/claude-opus-4.1"; // 全局默认 = 六档
  topo.modelConfig.catalog = {
    models: [
      catalogModel("anthropic/claude-opus-4.1", true, SIX),
      catalogModel("openai/gpt-5", true, TRI),
    ],
    refreshedAt: 0,
    source: "builtin",
    degraded: [],
  };
  if (slot !== null) topo.agentConfig = { revision: 1, slots: { "main-session": slot } };
  topologyRef.current = topo;
  return render(
    <I18nProvider>
      <ComposerThinkingPicker />
    </I18nProvider>,
  );
}

describe("ComposerThinkingPicker · 草稿基准换源（P1 T4）", () => {
  it("刻度基准 = 当前模式槽位模型能力位（非全局默认）：槽位 gpt-5（三档）→ 4 刻度非 7", () => {
    draftSetup({ slot: { model: "openai/gpt-5", thinking: "high" } });
    fireEvent.click(trigger());
    expect(document.querySelectorAll(".tl-tick")).toHaveLength(4); // off + TRI
    expect(document.querySelector('.tl-tick[data-level="max"]')).toBeNull(); // 非六档刻度（全局默认未侵染）
  });

  it("显示值回退链：无本地暂存 → 槽位 thinking（trigger HIGH + ghost 空心 thumb 停 high 位 + PEAK）", () => {
    draftSetup({ slot: { model: "openai/gpt-5", thinking: "high" } });
    expect(trigger().querySelector(".tp-level")!.textContent).toBe("HIGH");
    expect(trigger().classList.contains("peak")).toBe(true); // 显示位 = 最高档同触发 PEAK
    fireEvent.click(trigger());
    const thumb = document.querySelector<HTMLElement>(".tl-thumb")!;
    expect(thumb.classList.contains("ghost")).toBe(true); // 无本地暂存 = 预览位（空心）
    expect(thumb.style.left).toBe("100%"); // off+TRI 序 idx 3/3 = 100%
    expect(document.querySelector(".tl-tick.cur")).toBeNull(); // 刻度去强调
  });

  it("本地暂存优先：stash model（opus 六档）压槽位模型、stash thinking（low）压槽位 thinking", () => {
    draftSetup({
      slot: { model: "openai/gpt-5", thinking: "high" },
      model: "anthropic/claude-opus-4.1",
      override: "low",
      effective: "low",
    });
    expect(trigger().querySelector(".tp-level")!.textContent).toBe("LOW");
    fireEvent.click(trigger());
    expect(document.querySelectorAll(".tl-tick")).toHaveLength(7); // 刻度基准 = stash 模型能力位
    const thumb = document.querySelector<HTMLElement>(".tl-thumb")!;
    expect(thumb.classList.contains("ghost")).toBe(false); // 本地暂存 = 实心强调
    expect(thumb.style.left).toBe(`${(2 / 6) * 100}%`); // off+SIX 序「low」在 idx 2/6
  });

  it("槽位模型已配但 thinking 未配（null）→ 显示 OFF + ghost 停 off 位（默认关）", () => {
    draftSetup({ slot: { model: "openai/gpt-5", thinking: null } });
    expect(trigger().querySelector(".tp-level")!.textContent).toBe("OFF");
    fireEvent.click(trigger());
    const thumb = document.querySelector<HTMLElement>(".tl-thumb")!;
    expect(thumb.classList.contains("ghost")).toBe(true);
    expect(thumb.style.left).toBe("0%");
  });

  it("槽位未拉取（slots=null）→ 回退全局默认模型能力位（回归：旧两缀链不变）", () => {
    draftSetup();
    expect(trigger().querySelector(".tp-level")!.textContent).toBe("OFF");
    fireEvent.click(trigger());
    expect(document.querySelectorAll(".tl-tick")).toHaveLength(7); // defaultModel 六档
    expect(document.querySelector<HTMLElement>(".tl-thumb")!.style.left).toBe("0%");
  });

  it("草稿选档 → setSessionThinking（命令链不变，本地暂存）", () => {
    draftSetup({ slot: { model: "openai/gpt-5", thinking: "high" } });
    fireEvent.click(trigger());
    fireEvent.click(document.querySelector<HTMLButtonElement>('.tl-tick[data-level="medium"]')!);
    expect(setSessionThinking).toHaveBeenCalledWith("medium");
  });

  it("已建会话回归：槽位不侵染（刻度 = state.model 能力位；显示 = effective 权威）", () => {
    stateRef.current = {
      ...createInitialSessionState(),
      conn: "connected",
      view: "ready",
      sessionId: "s1", // 已建会话（thinking.changed 权威，P1 T4 不改语义）
      model: "openai/gpt-5",
      thinking: { override: "low", effective: "low" },
    };
    const topo = createInitialTopologyState();
    topo.modelConfig.catalog = {
      models: [catalogModel("openai/gpt-5", true, TRI), catalogModel("anthropic/claude-opus-4.1", true, SIX)],
      refreshedAt: 0,
      source: "builtin",
      degraded: [],
    };
    // 槽位配成 opus+high（若草稿逻辑误入已建链会变 7 刻度/HIGH）
    topo.agentConfig = { revision: 1, slots: { "main-session": { model: "anthropic/claude-opus-4.1", thinking: "high" } } };
    topologyRef.current = topo;
    render(
      <I18nProvider>
        <ComposerThinkingPicker />
      </I18nProvider>,
    );
    expect(trigger().querySelector(".tp-level")!.textContent).toBe("LOW");
    fireEvent.click(trigger());
    expect(document.querySelectorAll(".tl-tick")).toHaveLength(4);
    expect(document.querySelector<HTMLElement>(".tl-thumb")!.style.left).toBe(`${(1 / 3) * 100}%`);
  });
});
