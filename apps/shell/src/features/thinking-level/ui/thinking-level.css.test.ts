/**
 * thinking-level 样式纪律（node 环境直读样式表；jsdom 不加载 CSS；
 * AppLayout.css.test.ts 先例）。
 *
 * 机械判据（review.md §2 / test-design §3 双主题与设计系统）：
 * - popover 属 hud-popover 族：--popover-fill + blur 14px（亮色 10px）+
 *   10px 圆角 + 向上展开（bottom 锚定）；
 * - 滑块形态：2px 轨道 + accent 填充 + 11px 菱形 thumb（45° 旋转）；
 * - PEAK 四要素：强边 + glow-cyan + 6s 环绕光束（仅 transform/opacity 动画，
 *   WKWebView 纪律）+ 徽章；
 * - reduced-motion：光束静止（媒体查询规则存在）；
 * - 零新色板：样式表零裸 hex 色值（全部走 tokens.css 变量）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(
  fileURLToPath(new URL("../../../shared/ui/styles/workbench.css", import.meta.url)),
  "utf8",
);

describe("thinking-level CSS（P-1 hud-popover 族 + 滑块形态 + PEAK）", () => {
  it("popover：--popover-fill + blur(14px) + 10px 圆角 + 向上展开（bottom: calc(100% + 8px)）", () => {
    expect(css).toMatch(/\.tp-popover\s*\{[^}]*background:\s*var\(--popover-fill\)/);
    expect(css).toMatch(/\.tp-popover\s*\{[^}]*blur\(14px\)/);
    expect(css).toMatch(/\.tp-popover\s*\{[^}]*border-radius:\s*10px/);
    expect(css).toMatch(/\.tp-popover\s*\{[^}]*bottom:\s*calc\(100% \+ 8px\)/);
  });

  it("亮色降档：html.light 下 popover blur 10px", () => {
    expect(css).toMatch(/html\.light \.tp-popover\s*\{[^}]*blur\(10px\)/);
  });

  it("滑块形态：2px 轨道（.tl-rail/.tl-fill height:2px）+ 11px 菱形 thumb（45° 旋转）", () => {
    expect(css).toMatch(/\.tl-rail\s*\{[^}]*height:\s*2px/);
    expect(css).toMatch(/\.tl-fill\s*\{[^}]*height:\s*2px/);
    expect(css).toMatch(/\.tl-thumb\s*\{[^}]*width:\s*11px[^}]*height:\s*11px/);
    expect(css).toMatch(/\.tl-thumb\s*\{[^}]*rotate\(45deg\)/);
  });

  it("PEAK 四要素：强边 + glow-cyan + 徽章显隐 + 6s 光束（keyframes 仅 transform）", () => {
    expect(css).toMatch(/\.tp-trigger\.peak\s*\{[^}]*var\(--glow-cyan\)/);
    expect(css).toMatch(/\.tp-popover\.peak\s*\{[^}]*var\(--glow-cyan\)/);
    expect(css).toMatch(/\.tp-peak-badge\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/\.tp-popover\.peak \.tp-peak-badge\s*\{[^}]*display:\s*inline-flex/);
    expect(css).toMatch(/\.beam > i\s*\{[^}]*animation:\s*tp-beam-rot 6s linear infinite/);
    // WKWebView 纪律：光束 keyframes 仅 transform（零 top/left/width/height）
    const kf = css.match(/@keyframes tp-beam-rot\s*\{([\s\S]*?)\n\}/);
    expect(kf).not.toBeNull();
    expect(kf![1]).toContain("transform");
    expect(kf![1]).not.toMatch(/top|left|width|height/);
  });

  it("reduced-motion：光束静止（媒体查询规则存在）", () => {
    const rm = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*\.beam > i[^}]*animation:\s*none/);
    expect(rm).not.toBeNull();
  });

  it("P-2 字段框：dashed-able 壳（void 0.35 底 + 8px 圆角）+ unset dashed + PEAK 强边辉光（review.md §3 必须还原 2/6）", () => {
    expect(css).toMatch(/\.tl-box\s*\{[^}]*background:\s*rgb\(var\(--void-rgb\) \/ 0\.35\)/);
    expect(css).toMatch(/\.tl-box\s*\{[^}]*border-radius:\s*8px/);
    expect(css).toMatch(/\.tl-field\.unset \.tl-box\s*\{[^}]*border-style:\s*dashed/);
    expect(css).toMatch(/\.tl-box\.peak\s*\{[^}]*var\(--glow-cyan\)/);
  });

  it("零新色板：thinking 样式块零裸 hex 色值（全部走 token 变量）", () => {
    const block = css.match(/P-1 推理强度滑块[\s\S]*$/);
    expect(block).not.toBeNull();
    expect(block![0]).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
