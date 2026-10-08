/**
 * 声纹槽位组样式纪律（node 环境直读样式表；jsdom 不加载 CSS；
 * Composer.voice.css.test 先例）。
 *
 * 机械判据（v3 槽位批）：
 * - 5 槽横排网格 + gap 间距（横向排列、间距不重叠——用户偏好）；
 * - 窄屏降列（repeat(auto-fill)——槽卡不挤碎不重叠）；
 * - 槽位卡纵向堆叠 + 8px 圆角（与 hud-card 12px/按钮 6px 圆角体系同族）；
 * - 动作区定高 26px（hud-btn.sm 同高——按钮增减不破横排节奏）；
 * - 零裸 hex：vp-* 段全部 tokens.css 变量。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(
  fileURLToPath(new URL("../../../../shared/ui/styles/workbench.css", import.meta.url)),
  "utf8",
);

/** 抽取 .vp-* 段（.vp-slots 起到段尾）用于裸 hex 扫描。 */
function vpBlock(): string {
  const at = css.indexOf(".vp-slots {");
  expect(at).toBeGreaterThanOrEqual(0);
  return css.slice(at);
}

describe("声纹槽位组 CSS（v3 槽位批）", () => {
  it("5 槽横排网格：repeat(5, minmax(0,1fr)) + gap 间距", () => {
    expect(css).toMatch(/\.vp-slots\s*\{[^}]*grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/);
    expect(css).toMatch(/\.vp-slots\s*\{[^}]*gap:\s*8px/);
  });

  it("窄屏降列：repeat(auto-fill, minmax(...)) 防槽卡挤碎重叠", () => {
    expect(css).toMatch(/\.vp-slots\s*\{\s*grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(/);
  });

  it("槽位卡：纵向堆叠 + 圆角 + tokens 描边（无裸 hex）", () => {
    expect(css).toMatch(/\.vp-slot\s*\{[^}]*flex-direction:\s*column/);
    expect(css).toMatch(/\.vp-slot\s*\{[^}]*border-radius:\s*8px/);
    expect(css).toMatch(/\.vp-slot\s*\{[^}]*border:\s*1px solid rgb\(var\(--edge-rgb\)/);
  });

  it("动作区定高 26px（hud-btn.sm 同高——横排节奏稳定）", () => {
    expect(css).toMatch(/\.vp-slot-actions\s*\{[^}]*min-height:\s*26px/);
  });

  it("vp-* 段零裸 hex 色值（全部 tokens.css 变量）", () => {
    expect(vpBlock()).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
