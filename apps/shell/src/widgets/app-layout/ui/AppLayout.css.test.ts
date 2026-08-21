/**
 * S1 AppLayout CSS 布局纪律（node 环境直读样式表；jsdom 不加载 CSS）：
 * 根 100dvh flex column 自身不滚；.layout-main 唯一滚动容器；
 * .layout-body min-height:0 弹性链；窄屏降级同步。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("./app-layout.css", import.meta.url)), "utf8");

describe("S1 AppLayout CSS 布局纪律", () => {
  it("根：position:relative（浮层定位上下文）+ 100dvh + flex column", () => {
    expect(css).toMatch(/\.app-layout\s*\{[^}]*position:\s*relative/);
    expect(css).toMatch(/\.app-layout\s*\{[^}]*height:\s*100dvh/);
    expect(css).toMatch(/\.app-layout\s*\{[^}]*flex-direction:\s*column/);
  });

  it("唯一滚动容器：.layout-main overflow-y:auto + flex:1 + min-width:0；body min-height:0", () => {
    expect(css).toMatch(/\.layout-body\s*\{[^}]*min-height:\s*0/);
    expect(css).toMatch(/\.layout-main\s*\{[^}]*flex:\s*1 1 auto/);
    expect(css).toMatch(/\.layout-main\s*\{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.layout-main\s*\{[^}]*overflow-y:\s*auto/);
  });

  it("壳与 body 零滚动（overflow 未放开——页面滚动只发生在 .layout-main 内）", () => {
    expect(css).not.toMatch(/\.app-layout\s*\{[^}]*overflow(?:-y)?:\s*(?:auto|scroll)/);
    expect(css).not.toMatch(/\.layout-body\s*\{[^}]*overflow(?:-y)?:\s*(?:auto|scroll)/);
  });
});
