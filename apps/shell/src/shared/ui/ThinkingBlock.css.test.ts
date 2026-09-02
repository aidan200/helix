/**
 * thinking 流式块排版纪律（node 环境直读样式表；jsdom 不加载 CSS）：
 * 「思考中」标签独占一行——tl-label 必须块级（display:flex，非 inline-flex），
 * 否则 tl-text 是行内元素、第一行紧跟标签同行（流式首行贴标签 bug）。
 * tl-text 保持 pre-wrap（思考文本换行可见）。
 * 仿 AppLayout.css.test.ts 直读模式（app.css 由 shared/ui/styles 提供）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("./styles/app.css", import.meta.url)), "utf8");

describe("think-live 排版纪律", () => {
  it("tl-label 块级独占一行：display:flex 且非 inline-flex", () => {
    expect(css).toMatch(/\.think-live \.tl-label\s*\{[^}]*display:\s*flex/);
    expect(css).not.toMatch(/\.think-live \.tl-label\s*\{[^}]*display:\s*inline-flex/);
  });

  it("tl-text 换行可见：white-space:pre-wrap", () => {
    expect(css).toMatch(/\.think-live \.tl-text\s*\{[^}]*white-space:\s*pre-wrap/);
  });
});
