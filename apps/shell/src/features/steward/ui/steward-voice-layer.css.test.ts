/**
 * 管家全局光球层 CSS 纪律测试（B2；node 环境直读样式表——jsdom 不加载
 * CSS；steward-dock.css.test 直读模式同构）。
 *
 * 钉纪律（Cyber HUD 铁律：色值/字号走 token 注册表变量零内联 hex；动效
 * 仅 transform/opacity，animation 简写禁 calc()/var()——E-124 WKWebView）：
 * - .stv 真全屏语义：fixed 视口层 + z 序压过 StewardDock（z-index 68）；
 * - 字幕条玻璃族：popover-fill + blur 14px（亮色降 10px）+ shadow-pop +
 *   10px 圆角（E-135 面板视觉基准）；
 * - 光球径向渐变全走通道 token（accent/violet——零散 hex 零容忍）；
 * - 堆叠渐隐纯 opacity（nth-last-child 阶梯）；
 * - 呼吸动画仅 transform/opacity；reduced-motion 全关停。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(
  fileURLToPath(new URL("../../../shared/ui/styles/app.css", import.meta.url)),
  "utf8",
);

const SEG_START = css.indexOf("/* ── 管家全局光球层");
expect(SEG_START).toBeGreaterThan(0);
const seg = css.slice(SEG_START);

describe("管家全局光球层 CSS 纪律（Cyber HUD token 合规）", () => {
  it("真全屏语义：fixed 视口层 + z-index 68（压过 StewardDock 60/ConfirmStack 65）+ pointer-events 穿透", () => {
    expect(seg).toMatch(/\.stv\s*\{[^}]*position:\s*fixed/);
    expect(seg).toMatch(/\.stv\s*\{[^}]*z-index:\s*68/);
    expect(seg).toMatch(/\.stv\s*\{[^}]*pointer-events:\s*none/);
    expect(seg).toMatch(/\.stv-orb\s*\{[^}]*pointer-events:\s*auto/); // 光球本体可点（D5）
  });

  it("字幕条玻璃族：popover-fill + blur 14px（亮色降 10px）+ shadow-pop + 10px 圆角", () => {
    expect(seg).toMatch(/\.stv-caption\s*\{[^}]*background:\s*var\(--popover-fill\)/);
    expect(seg).toMatch(/\.stv-caption\s*\{[^}]*backdrop-filter:\s*blur\(14px\)/);
    expect(seg).toMatch(/html\.light \.stv-caption\s*\{[^}]*backdrop-filter:\s*blur\(10px\)/);
    expect(seg).toMatch(/\.stv-caption\s*\{[^}]*box-shadow:\s*var\(--shadow-pop\)/);
    expect(seg).toMatch(/\.stv-caption\s*\{[^}]*border-radius:\s*10px/);
  });

  it("零内联 hex / 零裸 rgb 三元字面量（通道变量模式唯一合法）", () => {
    expect(seg).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    const bareRgb = seg.match(/rgb\((?!\s*var\()[^)]*\)/g) ?? [];
    expect(bareRgb).toEqual([]);
  });

  it("字号全走 --text-* 语义阶梯（无 px 字号字面量）", () => {
    expect(seg).not.toMatch(/font-size:\s*\d/);
    expect(seg).toMatch(/font-size:\s*var\(--text-body\)/);
  });

  it("光球径向渐变走 accent/violet 通道 token（相位色彩通道切换）", () => {
    expect(seg).toMatch(/\.stv-orb\s*\{[^}]*radial-gradient\([^)]*var\(--accent-rgb\)/s);
    expect(seg).toMatch(/\.stv-orb\.stv-phase-thinking[^{]*\{[^}]*var\(--violet-rgb\)/s);
  });

  it("动效仅 transform/opacity + 堆叠渐隐纯 opacity + reduced-motion 全关停", () => {
    expect(seg).toMatch(/@keyframes stv-breathe\s*\{[^@]*?opacity:\s*1[^@]*?transform:\s*scale/s);
    expect(seg).toMatch(/\.stv-line:nth-last-child\(5\)\s*\{[^}]*opacity/); // 渐隐阶梯
    expect(seg).toMatch(/\.stv-orb-ring\s*\{[^}]*transform:\s*scale\(var\(--stv-lv/); // var 驱动不入 animation
    // animation 简写零 var()/calc()（E-124）
    const animationLines = seg.match(/animation:[^;]+;/g) ?? [];
    for (const line of animationLines) {
      expect(line.includes("var(")).toBe(false);
      expect(line.includes("calc(")).toBe(false);
    }
    expect(seg).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.stv-orb\s*\{[^}]*animation:\s*none/);
  });
});
