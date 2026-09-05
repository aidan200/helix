/**
 * 工作台账条浮窗纪律（node 环境直读样式表；jsdom 不加载 CSS）：
 * 展开态 wl-items 必须脱离文档流（absolute 锚摘要条下沿）——展开后覆盖
 * 消息流而非推挤，主窗口布局零位移（摘要条常驻位不动）。
 * 浮窗可读性三件套：popover-fill 实底（遮住底下消息文字）+ 描边 +
 * 内部滚动（条目多时浮窗内滚，不外溢）。
 * 仿 AppLayout.css.test.ts / ThinkingBlock.css.test.ts 直读模式（app.css
 * 由 shared/ui/styles 提供）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(
  fileURLToPath(new URL("../../../shared/ui/styles/app.css", import.meta.url)),
  "utf8",
);

describe("工作台账条浮窗纪律", () => {
  it("wl-bar 是浮窗定位上下文：position:relative", () => {
    expect(css).toMatch(/\.wl-bar\s*\{[^}]*position:\s*relative/);
  });

  it("wl-items 脱文档流：absolute + top:100%（贴摘要条下沿）+ left/right:0 全宽", () => {
    expect(css).toMatch(/\.wl-items\s*\{[^}]*position:\s*absolute/);
    expect(css).toMatch(/\.wl-items\s*\{[^}]*top:\s*100%/);
    expect(css).toMatch(/\.wl-items\s*\{[^}]*left:\s*0/);
    expect(css).toMatch(/\.wl-items\s*\{[^}]*right:\s*0/);
  });

  it("浮窗实底遮消息：popover-fill 背景 + 内部滚动（overflow-y:auto）", () => {
    expect(css).toMatch(/\.wl-items\s*\{[^}]*background:\s*var\(--popover-fill\)/);
    expect(css).toMatch(/\.wl-items\s*\{[^}]*overflow-y:\s*auto/);
  });
});
