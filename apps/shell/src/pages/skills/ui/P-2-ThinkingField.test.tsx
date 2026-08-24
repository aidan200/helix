// @vitest-environment jsdom
/**
 * P2ThinkingField 单测（pages/skills/ui；thinking 批 T3——on/off 开关形态）。
 *
 * 机械判据（用户决策：「think 等级是有 on/off 的开关的，on 的时候获取当前
 * 模型最新的支持的档位列表，然后再渲染滑块组件」）：
 * - off = 槽位空默认关：开关 off（role=switch + aria-checked=false + 状态词
 *   停用）+ 无滑块 / 无档位徽标 / 无说明行（noteUnset* noteConfigured* 已删）；
 * - off → on：立即 onSelect 中位档（defaultLevelFor：[low,high,max]→high、
 *   [low,high]→low、[minimal,low,medium,high]→low；纯函数全矩阵见
 *   thinking-capability.test.ts）；
 * - on → off：onClear 清槽位（清除钮 .tl-clear 已由开关承担移除）；
 * - reasoning=false：开关 disabled + disabledNote 保留（唯一存留说明行），
 *   已有配置保留（徽标仍示配置档）；
 * - 能力位未判明（catalog 未达）：开关 disabled + capabilityLoading 提示位；
 * - 既有边界变体跟随：单档 configured → PEAK；低于最低支持档 → 展示位钳制
 *   + 轻提示 + 配置值不改写；
 * - NFR-1 负断言：UI 档位集 = 能力位原样透传（无 "off"/关闭档注入）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { CatalogModel } from "@helix/protocol";
import { I18nProvider } from "@/shared/i18n";
import P2ThinkingField from "./P-2-ThinkingField";

afterEach(cleanup);

// 词条断言基准 zh-CN（detectLang 读 localStorage 优先；AG-14 白名单键）
localStorage.setItem("helix-lang", "zh-CN");

function cap(id: string, reasoning: boolean, thinkingLevels: string[]): CatalogModel {
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

const TRI = ["low", "medium", "high"];

function setup(opts: {
  kind?: "main-session" | "subagent-worker";
  thinkingLevel: string | null;
  capability: CatalogModel | undefined;
}) {
  const onSelect = vi.fn();
  const onClear = vi.fn();
  render(
    <I18nProvider>
      <P2ThinkingField
        kind={opts.kind ?? "subagent-worker"}
        thinkingLevel={opts.thinkingLevel}
        capability={opts.capability}
        disabled={false}
        onSelect={onSelect}
        onClear={onClear}
      />
    </I18nProvider>,
  );
  const field = document.querySelector<HTMLElement>(
    `[data-thinking-field="${opts.kind ?? "subagent-worker"}"]`,
  )!;
  return {
    onSelect,
    onClear,
    field,
    switchEl: field.querySelector<HTMLButtonElement>('[data-switch="thinking"]')!,
  };
}

describe("P2ThinkingField · on/off 开关形态（T3）", () => {
  it("off = 槽位空默认关：开关 off（停用状态词）+ 无滑块 / 无徽标 / 无说明行；挂载零写命令", () => {
    const { field, switchEl, onSelect, onClear } = setup({
      thinkingLevel: null,
      capability: cap("openai/gpt-5-mini", true, TRI),
    });
    // 开关：语义化 role=switch + aria-checked=false + 状态词「停用」
    expect(switchEl.getAttribute("role")).toBe("switch");
    expect(switchEl.getAttribute("aria-checked")).toBe("false");
    expect(switchEl.classList.contains("on")).toBe(false);
    expect(switchEl.querySelector(".ag-switch-state")!.textContent).toBe("停用");
    expect(switchEl.disabled).toBe(false); // 能力就绪可开
    // off 态：无滑块 / 无档位徽标 / 无说明行 / 无清除钮
    expect(field.querySelector(".tl-track")).toBeNull();
    expect(field.querySelector(".tl-state")).toBeNull();
    expect(field.querySelector(".tl-note")).toBeNull();
    expect(field.querySelector(".tl-clear")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
  });

  it("off → on：槽位空 → onSelect 中位档（[low,high,max]→high；[low,high]→low；[minimal,low,medium,high]→low）", () => {
    const a = setup({ thinkingLevel: null, capability: cap("x/alpha", true, ["low", "high", "max"]) });
    fireEvent.click(a.switchEl);
    expect(a.onSelect).toHaveBeenCalledWith("high");
    expect(a.onClear).not.toHaveBeenCalled();
    cleanup();
    const b = setup({ thinkingLevel: null, capability: cap("x/beta", true, ["low", "high"]) });
    fireEvent.click(b.switchEl);
    expect(b.onSelect).toHaveBeenCalledWith("low");
    cleanup();
    const c = setup({ thinkingLevel: null, capability: cap("x/gamma", true, ["minimal", "low", "medium", "high"]) });
    fireEvent.click(c.switchEl);
    expect(c.onSelect).toHaveBeenCalledWith("low");
  });

  it("on → off：onClear 清槽位（零 onSelect）", () => {
    const { switchEl, onSelect, onClear } = setup({
      thinkingLevel: "high",
      capability: cap("openai/gpt-5-mini", true, TRI),
    });
    expect(switchEl.getAttribute("aria-checked")).toBe("true"); // configured = 开关 on
    fireEvent.click(switchEl);
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("on 态：滑块渲染（档位徽标示配置档 + 状态词「启用」）+ levels 无 OFF 刻度注入", () => {
    const { field, switchEl } = setup({
      thinkingLevel: "high",
      capability: cap("openai/gpt-5-mini", true, TRI),
    });
    expect(switchEl.getAttribute("aria-checked")).toBe("true");
    expect(switchEl.querySelector(".ag-switch-state")!.textContent).toBe("启用");
    expect(field.querySelector(".tl-state")!.textContent).toBe("high");
    expect(field.querySelector(".tl-state")!.classList.contains("set")).toBe(true);
    const levels = Array.from(field.querySelectorAll<HTMLButtonElement>(".tl-tick")).map((b) => b.dataset.level);
    expect(levels).toEqual(TRI);
    expect(levels).not.toContain("off");
  });

  it("reasoning=false：开关 disabled + disabledNote 保留；已有配置保留（徽标仍示配置档）", () => {
    const { field, switchEl } = setup({
      thinkingLevel: "high",
      capability: cap("local/qwen3-4b", false, []),
    });
    expect(field.classList.contains("disabled")).toBe(true);
    expect(switchEl.disabled).toBe(true);
    expect(switchEl.getAttribute("aria-checked")).toBe("true"); // 配置保留不可改
    expect(field.querySelector(".tl-state")!.textContent).toBe("high");
    expect(field.querySelector(".tl-track")).toBeNull(); // 滑块不渲染
    expect(field.querySelector(".tl-note")!.textContent).toContain("不支持 reasoning");
    cleanup();
    // reasoning=false + 未配置：开关 disabled + off
    const u = setup({ thinkingLevel: null, capability: cap("local/qwen3-4b", false, []) });
    expect(u.switchEl.disabled).toBe(true);
    expect(u.switchEl.getAttribute("aria-checked")).toBe("false");
    expect(u.field.querySelector(".tl-note")!.textContent).toContain("不支持 reasoning");
  });

  it("能力位未判明（capability=undefined）：开关 disabled + capabilityLoading 提示位", () => {
    const { field, switchEl } = setup({ thinkingLevel: null, capability: undefined });
    expect(switchEl.disabled).toBe(true);
    expect(field.querySelector(".tl-cap-loading")!.textContent).toContain("正在获取模型能力");
    expect(field.querySelector(".tl-track")).toBeNull();
  });

  it("四条 note 文案不再渲染（unset / configured × main / sub 均无说明行）", () => {
    const variants = [
      { kind: "main-session" as const, thinkingLevel: null },
      { kind: "subagent-worker" as const, thinkingLevel: null },
      { kind: "main-session" as const, thinkingLevel: "high" },
      { kind: "subagent-worker" as const, thinkingLevel: "high" },
    ];
    for (const v of variants) {
      cleanup();
      const { field } = setup({ kind: v.kind, thinkingLevel: v.thinkingLevel, capability: cap("openai/gpt-5-mini", true, TRI) });
      expect(field.querySelector(".tl-note")).toBeNull();
    }
    const all = document.body.textContent ?? "";
    expect(all).not.toContain("回落兜底");
    expect(all).not.toContain("解析推理级别");
    expect(all).not.toContain("解析快照");
    expect(all).not.toContain("composer 会话覆盖");
  });
});

describe("P2ThinkingField · 既有边界变体跟随（configured 路径不变）", () => {
  it("单档变体：configured 单档即最高档 → PEAK（唯一档 = 能力上限）", () => {
    const { field } = setup({ thinkingLevel: "medium", capability: cap("local/phi-4", true, ["medium"]) });
    expect(field.querySelectorAll(".tl-tick")).toHaveLength(1);
    const thumb = field.querySelector<HTMLElement>(".tl-thumb")!;
    expect(thumb.style.left).toBe("0%");
    expect(thumb.style.left).not.toContain("NaN");
    expect(field.querySelector(".tl-box")!.classList.contains("peak")).toBe(true);
  });

  it("低于最低支持档：configured minimal + 三档 → 展示位落 low + 轻提示 + 配置值不改写", () => {
    const { field, onSelect } = setup({ thinkingLevel: "minimal", capability: cap("openai/gpt-5-mini", true, TRI) });
    expect(field.querySelector<HTMLElement>(".tl-thumb")!.style.left).toBe("0%");
    expect(field.querySelector(".tl-tick.cur")!.textContent).toBe("low");
    expect(field.querySelector(".tl-hint")!.textContent).toBe(
      "minimal → low（模型能力所限；spawn 解析时按能力过滤，配置值不丢）",
    );
    expect(field.querySelector(".tl-state")!.textContent).toBe("minimal");
    expect(onSelect).not.toHaveBeenCalled();
  });
});
