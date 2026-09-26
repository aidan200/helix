/**
 * 管家全局光球层 CSS 纪律测试（B2 皮面 + P1 像素光球精灵换皮；node 环境
 * 直读样式表——jsdom 不加载 CSS；steward-dock.css.test 直读模式同构）。
 *
 * 钉纪律（Cyber HUD 铁律：色值/字号走 token 注册表变量零内联 hex；动效
 * 仅 transform/opacity，animation 简写禁 calc()/var()——E-124 WKWebView）：
 * - .stv 真全屏语义：fixed 视口层 + z 序压过 StewardDock（z-index 68）；
 * - 字幕条玻璃族（用户裁决视觉例外）：popover-fill + blur 14px（亮色降
 *   10px）+ shadow-pop 保持；**直角（radius 0）+ 无边框**（用户裁决，
 *   E-135 玻璃族 border/10px 圆角条款对管家族例外——候选台账留痕）；
 *   满窗高（max-height = 100vh - 126px：扣 bottom 20 + 光球 96 + 间距 10）
 *   + justify-content: flex-end（溢出裁最旧行于顶，最新行恒完整——
 *   「最下面一行显示不全」根修）——**光球命中区 96px 是该 calc 的锚**；
 * - P1 皮面（像素光球精灵）：球体/光晕/表情面三层结构；球体硬止径向色阶
 *   全走通道 token（accent 基态 / violet 输出态——零散 hex 零容忍）；
 * - 均衡器嘴 = RMS 嘴动：--stv-b1..b3 由 TSX 预计算（E-124：calc 乘法
 *   不进 CSS——**整段 calc( 零容忍**，比旧版加严）；
 * - keyframes 仅 transform/opacity（blink/dots 关键帧紧邻百分比=像素
 *   snap）；animation 简写零 var()/calc()；reduced-motion 全关停。
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

describe("管家全局光球层 CSS 纪律（Cyber HUD token 合规 + P1 像素精灵皮面）", () => {
  it("真全屏语义：fixed 视口层 + z-index 68（压过 StewardDock 60/ConfirmStack 65）+ pointer-events 穿透", () => {
    expect(seg).toMatch(/\.stv\s*\{[^}]*position:\s*fixed/);
    expect(seg).toMatch(/\.stv\s*\{[^}]*z-index:\s*68/);
    expect(seg).toMatch(/\.stv\s*\{[^}]*pointer-events:\s*none/);
    expect(seg).toMatch(/\.stv-orb\s*\{[^}]*pointer-events:\s*auto/); // 光球本体可点（D5）
  });

  it("光球命中区 96px（字幕条满窗高 calc(100vh - 126px) 的锚：20 底距 + 96 球 + 10 间距）", () => {
    expect(seg).toMatch(/\.stv-orb\s*\{[^}]*width:\s*96px/);
    expect(seg).toMatch(/\.stv-orb\s*\{[^}]*height:\s*96px/);
  });

  it("字幕条玻璃族（用户裁决）：直角 + 无边框 + 满窗高 + 溢出裁顶保最新行", () => {
    const caption = seg.match(/\.stv-caption\s*\{[^}]*\}/)![0];
    expect(seg).toMatch(/\.stv-caption\s*\{[^}]*background:\s*var\(--popover-fill\)/);
    expect(seg).toMatch(/\.stv-caption\s*\{[^}]*backdrop-filter:\s*blur\(14px\)/);
    expect(seg).toMatch(/html\.light \.stv-caption\s*\{[^}]*backdrop-filter:\s*blur\(10px\)/);
    expect(seg).toMatch(/\.stv-caption\s*\{[^}]*box-shadow:\s*var\(--shadow-pop\)/);
    expect(caption).toMatch(/border-radius:\s*0/); // 直角（用户裁决）
    expect(caption).not.toMatch(/border:/); // 无边框（用户裁决）
    expect(caption).toMatch(/max-height:\s*calc\(100vh - 126px\)/); // 满窗高（扣 bottom 20 + 光球 96 + gap 10）
    expect(caption).toMatch(/justify-content:\s*flex-end/); // 溢出裁最旧行于顶，最新行恒完整
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

  it("P1 像素球体：硬止径向色阶走 accent/violet 通道 token（相位色彩通道切换）", () => {
    expect(seg).toMatch(/\.stv-orb-body\s*\{[^}]*radial-gradient\([^;]*var\(--accent-rgb\)/s);
    expect(seg).toMatch(/\.stv-orb\.stv-phase-thinking \.stv-orb-body,[\s\S]{0,120}?\.stv-orb-body\s*\{[^}]*var\(--violet-rgb\)/s);
    expect(seg).toMatch(/\.stv-orb-glow\s*\{[^}]*rgb\(var\(--accent-rgb/);
  });

  it("表情面结构：双眼 + 三条均衡器嘴（眼 void 通道 / 嘴 var 驱动 scaleY）", () => {
    expect(seg).toMatch(/\.stv-eye\s*\{[^}]*background:\s*rgb\(var\(--void-rgb/);
    expect(seg).toMatch(/\.stv-bar:nth-child\(1\)\s*\{[^}]*transform:\s*scaleY\(var\(--stv-b1/);
    expect(seg).toMatch(/\.stv-bar:nth-child\(2\)\s*\{[^}]*transform:\s*scaleY\(var\(--stv-b2/);
    expect(seg).toMatch(/\.stv-bar:nth-child\(3\)\s*\{[^}]*transform:\s*scaleY\(var\(--stv-b3/);
  });

  it("光球皮面段 calc 零容忍（E-124 加严：电平系数 TSX 预计算 --stv-b1..b3；字幕条布局 calc 为减法合法保留项）", () => {
    const orbSeg = seg.slice(seg.indexOf("/* 光球（P1"));
    expect(orbSeg.length).toBeGreaterThan(0);
    expect(orbSeg).not.toMatch(/calc\(/);
  });

  it("keyframes 仅 transform/opacity + animation 简写零 var()/calc()（E-124）", () => {
    for (const name of ["stv-breathe", "stv-glow", "stv-blink", "stv-dots"]) {
      const m = seg.match(new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?)\\n\\}`));
      expect(m, `keyframes ${name} 应存在`).not.toBeNull();
      const block = m![1] ?? "";
      expect(
        block.match(/(?:left|top|right|bottom|width|height|background|border|box-shadow|margin|padding|filter)\s*:/),
      ).toBeNull();
    }
    const animationLines = seg.match(/animation:[^;]+;/g) ?? [];
    for (const line of animationLines) {
      expect(line.includes("var(")).toBe(false);
      expect(line.includes("calc(")).toBe(false);
    }
  });

  it("reduced-motion 全关停（球体/光晕/眨眼/省略号脉冲/嘴动 transition）", () => {
    expect(seg).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.stv-orb\s*\{[^}]*animation:\s*none/);
    expect(seg).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.stv-orb-body,\s*\.stv-orb-glow,\s*\.stv-eye/);
    expect(seg).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.stv-bar\s*\{[^}]*transition:\s*none/);
  });
});
