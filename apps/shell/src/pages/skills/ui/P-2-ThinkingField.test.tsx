// @vitest-environment jsdom
/**
 * P2ThinkingField 边界变体 + NFR-1 负断言单测（pages/skills/ui；thinking 批
 * T3.2 核销补缺——AgentPage.test.tsx 已覆盖三变体/ghost/清除/换模提示/PEAK
 * 主链，本文件只补 test-design §4 thinkingLevels 边界变体矩阵与 §2.7 红线）。
 *
 * 机械判据：
 * - 单档变体（n=1）：pct 防除零（thumb 0%，无 NaN）；configured 单档即最高档
 *   → PEAK（唯一档 = 能力上限）；ghost 兜底 medium 在场 → 停 0 位；
 * - 低于最低支持档：configured minimal + 三档 [low,medium,high] → 展示位落
 *   low（levels[0] 回落分支）+ 轻提示「minimal → low（…配置值不丢）」+ 徽标
 *   仍示 minimal（配置值本体不改写，零写命令）；
 * - NFR-1 负断言：UI 档位集 = 能力位原样透传（无 "off"/关闭档注入）；无
 *   「关闭 reasoning」类入口文案；原型标注锚不存在。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
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
  thinkingLevel: string | null;
  capability: CatalogModel | undefined;
}) {
  const onSelect = vi.fn();
  const onClear = vi.fn();
  render(
    <I18nProvider>
      <P2ThinkingField
        kind="subagent-worker"
        thinkingLevel={opts.thinkingLevel}
        capability={opts.capability}
        disabled={false}
        onSelect={onSelect}
        onClear={onClear}
      />
    </I18nProvider>,
  );
  return { onSelect, onClear, field: document.querySelector<HTMLElement>('[data-thinking-field="subagent-worker"]')! };
}

describe("P2ThinkingField · 边界变体（test-design §4 矩阵）", () => {
  it("单档变体：1 刻度 + thumb 0% 无 NaN；configured 单档即最高档 → PEAK", () => {
    const { field } = setup({ thinkingLevel: "medium", capability: cap("local/phi-4", true, ["medium"]) });
    expect(field.querySelectorAll(".tl-tick")).toHaveLength(1);
    const thumb = field.querySelector<HTMLElement>(".tl-thumb")!;
    expect(thumb.style.left).toBe("0%");
    expect(thumb.style.left).not.toContain("NaN");
    // 单档 = 能力上限 → PEAK（唯一档即最高支持档）
    expect(field.querySelector(".tl-box")!.classList.contains("peak")).toBe(true);
    cleanup();
    // 单档 unset：ghost 兜底 medium 在场 → 空心 thumb 停 0 位
    const g = setup({ thinkingLevel: null, capability: cap("local/phi-4", true, ["medium"]) });
    const gThumb = g.field.querySelector<HTMLElement>(".tl-thumb")!;
    expect(gThumb.classList.contains("ghost")).toBe(true);
    expect(gThumb.style.left).toBe("0%");
    expect(g.field.querySelector(".tl-box")!.classList.contains("peak")).toBe(false); // unset 不触发
  });

  it("低于最低支持档：configured minimal + 三档 → 展示位落 low + 轻提示 + 配置值不改写", () => {
    const { field, onSelect } = setup({ thinkingLevel: "minimal", capability: cap("openai/gpt-5-mini", true, TRI) });
    // 展示位 = levels[0] 回落分支（low = tri idx0 → 0%）
    expect(field.querySelector<HTMLElement>(".tl-thumb")!.style.left).toBe("0%");
    expect(field.querySelector(".tl-tick.cur")!.textContent).toBe("low");
    // 轻提示（配置值不丢语义）
    expect(field.querySelector(".tl-hint")!.textContent).toBe(
      "minimal → low（模型能力所限；spawn 解析时按能力过滤，配置值不丢）",
    );
    // 配置值本体不改写：徽标仍示 minimal + 零写命令
    expect(field.querySelector(".tl-state")!.textContent).toBe("minimal");
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("P2ThinkingField · NFR-1 负断言（无关闭态红线）", () => {
  it("UI 档位集 = 能力位原样透传：无 off/关闭档注入；无「关闭 reasoning」入口；原型标注锚不存在", () => {
    setup({ thinkingLevel: "high", capability: cap("anthropic/claude-opus-4.1", true, ["minimal", "low", "medium", "high", "xhigh", "max"]) });
    const levels = Array.from(document.querySelectorAll<HTMLButtonElement>(".tl-tick")).map((b) => b.dataset.level);
    expect(levels).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]); // 精等：无注入
    expect(levels).not.toContain("off");
    const all = document.body.textContent ?? "";
    expect(all).not.toContain("关闭 reasoning");
    expect(all).not.toContain("关闭推理");
    expect(all).not.toContain("turn off");
    expect(document.querySelector("[data-proto-annotation]")).toBeNull();
  });

  it("ghost 态同样无 off 档注入（刻度集 = 三档原样）", () => {
    setup({ thinkingLevel: null, capability: cap("openai/gpt-5-mini", true, TRI) });
    const levels = Array.from(document.querySelectorAll<HTMLButtonElement>(".tl-tick")).map((b) => b.dataset.level);
    expect(levels).toEqual(TRI);
    expect(levels).not.toContain("off");
  });
});
