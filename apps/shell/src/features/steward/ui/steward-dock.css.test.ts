/**
 * 管家全局弹层 CSS 纪律测试（管家全局化批；node 环境直读样式表——
 * jsdom 不加载 CSS；仿 ChatStatusBar.css.test.ts 直读模式）。
 *
 * 钉纪律（Cyber HUD 铁律：所有色值/字号/透明度走 token 注册表变量，
 * 零散 hex 零容忍；动效仅 transform/opacity）：
 * - .stp-dock 弹层语义：fixed 定位 + popover-fill 0.8 档底 + blur 14px
 *   （亮色降 10px，html.light 覆盖）+ shadow-pop 投影 + 10px 圆角；
 * - stp 段零内联 hex / 零裸 rgb() 三元色字面量（通道变量 rgb(var(--x-rgb)) 除外）；
 * - 字号全走 --text-* 语义阶梯（无 px 字号字面量）；
 * - 入场动效只动 transform/opacity；reduced-motion 关停。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(
  fileURLToPath(new URL("../../../shared/ui/styles/app.css", import.meta.url)),
  "utf8",
);

/** 截取 stp 段（管家弹层段注释 → 段尾标记行；V3a 语音面块纳入守护面）。 */
const SEG_START = css.indexOf("/* ── 管家全局弹层");
const SEG_END = css.indexOf(".stp-wave-bar { transition: none; }");
expect(SEG_START).toBeGreaterThan(0);
expect(SEG_END).toBeGreaterThan(SEG_START);
const seg = css.slice(SEG_START, SEG_END);

describe("管家全局弹层 CSS 纪律（Cyber HUD token 合规）", () => {
  it("弹层语义：fixed + popover-fill + blur 14px + shadow-pop + 10px 圆角 + z 层", () => {
    expect(seg).toMatch(/\.stp-dock\s*\{[^}]*position:\s*fixed/);
    expect(seg).toMatch(/\.stp-dock\s*\{[^}]*background:\s*var\(--popover-fill\)/);
    expect(seg).toMatch(/\.stp-dock\s*\{[^}]*backdrop-filter:\s*blur\(14px\)/);
    expect(seg).toMatch(/\.stp-dock\s*\{[^}]*border-radius:\s*10px/);
    expect(seg).toMatch(/\.stp-dock\s*\{[^}]*box-shadow:\s*var\(--shadow-pop\)/);
    expect(seg).toMatch(/\.stp-dock\s*\{[^}]*z-index:\s*60/);
  });

  it("亮色降档：html.light .stp-dock blur 10px（tokens.md §07 弹层亮色档）", () => {
    expect(seg).toMatch(/html\.light \.stp-dock\s*\{[^}]*backdrop-filter:\s*blur\(10px\)/);
  });

  it("零内联 hex / 零裸 rgb 三元字面量（通道变量模式唯一合法）", () => {
    expect(seg).not.toMatch(/#[0-9a-fA-F]{3,8}\b/); // 无 hex
    // rgb(...) 只允许 rgb(var(--x-rgb) / a) 通道形态
    const bareRgb = seg.match(/rgb\((?!\s*var\()[^)]*\)/g) ?? [];
    expect(bareRgb).toEqual([]);
  });

  it("字号全走 --text-* 语义阶梯（无 px 字号字面量）", () => {
    expect(seg).not.toMatch(/font-size:\s*\d/);
    expect(seg).toMatch(/font-size:\s*var\(--text-title\)/);
    expect(seg).toMatch(/font-size:\s*var\(--text-body\)/);
  });

  it("入场动效仅 transform/opacity + reduced-motion 关停", () => {
    expect(seg).toMatch(/@keyframes stp-in\s*\{[^@]*?opacity:\s*0[^@]*?transform:/s);
    expect(seg).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.stp-dock\s*\{[^}]*animation:\s*none/);
  });

  it("在线状态 chip：success 语义色 token（非装饰点——enabled 态功能指示）", () => {
    expect(seg).toMatch(/\.stp-status\.on\s*\{[^}]*color:\s*var\(--success\)/);
    expect(seg).toMatch(/\.stp-status\.on\s*\{[^}]*rgb\(var\(--success-rgb\) \/ 0\.4\)/);
  });
});

describe("麦克风电平条 CSS 纪律（语音输入 V2）", () => {
  it("电平条只动 transform（scaleY var 驱动，零 calc）+ reduced-motion 关过渡", () => {
    expect(css).toMatch(/\.mic-level i\s*\{[^}]*transform:\s*scaleY\(var\(--lv1, 0\.2\)\)/);
    expect(css).toMatch(/\.mic-level i\s*\{[^}]*transition:\s*transform/);
    expect(css).not.toMatch(/\.mic-level[^}]*calc\(/s);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.mic-level i\s*\{[^}]*transition:\s*none/);
  });

  it("录音态 error 语义色 token（旧 #ff5555 散落 hex 随本批合规化）", () => {
    expect(css).toMatch(/\.mic-btn\.recording\s*\{[^}]*color:\s*var\(--error\)/);
    expect(css).not.toMatch(/\.mic-btn[^{]*\{[^}]*#ff5555/);
    expect(css).not.toMatch(/\.mic-btn[^{]*\{[^}]*rgb\(255 85 85/);
  });
});
