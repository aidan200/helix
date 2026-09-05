/**
 * ChatStatusBar chat 状态行 CSS 纪律测试（node 环境直读样式表；jsdom 不加载 CSS；
 * 仿 WorkLedgerBar.css.test.ts / AppLayout.css.test.ts 直读模式）。
 *
 * 钉纪律：
 * - 行高恒定：.chat-status-bar 固定 height（非 min-height）+ flex-shrink:0——
 *   常驻占位，内容有无不影响布局（对话气泡卡片与输入框间距恒定）；
 * - 三槽 flex：display:flex（左/中/右行内布局）；
 * - E-89 收拢：.steer-dock / .wp-inline 均为行内形态（不再 position:absolute
 *   钉 .msg-flow-wrap）——状态行整体位于滚动容器之外；
 * - dock 展开清单向上弹出：.sdq-list absolute + bottom:100%（锚 dock 上沿，
 *   覆盖消息流而非推挤——WorkLedgerBar wl-items 浮窗同纪律）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(
  fileURLToPath(new URL("../../../shared/ui/styles/app.css", import.meta.url)),
  "utf8",
);

describe("ChatStatusBar chat 状态行 CSS 纪律（T1）", () => {
  it("行高恒定：固定 height 28px（非 min-height）+ flex-shrink:0 + display:flex（三槽）", () => {
    expect(css).toMatch(/\.chat-status-bar\s*\{[^}]*display:\s*flex/);
    expect(css).toMatch(/\.chat-status-bar\s*\{[^}]*height:\s*28px/);
    expect(css).toMatch(/\.chat-status-bar\s*\{[^}]*flex-shrink:\s*0/);
    // 非 min-height（可增长即不恒定）
    expect(css).not.toMatch(/\.chat-status-bar\s*\{[^}]*min-height/);
  });

  it("中槽 diff 预留占位：.csb-mid 吃掉剩余空间（flex-grow）", () => {
    expect(css).toMatch(/\.csb-mid\s*\{[^}]*flex:\s*1/);
  });

  it("WorkPhaseDot 行内形态：.wp-inline 无 absolute 钉位（浮动旧形态退役）", () => {
    expect(css).toMatch(/\.wp-inline\s*\{/);
    expect(css).not.toMatch(/\.wp-inline\s*\{[^}]*position:\s*absolute/);
    expect(css).not.toMatch(/\.wp-float/);
  });

  it("SteerQueueDock 行内形态：.steer-dock 无 absolute 钉位；.sdq-list 向上弹出（absolute + bottom:100%，不推挤布局）", () => {
    expect(css).toMatch(/\.steer-dock\s*\{[^}]*position:\s*relative/);
    expect(css).not.toMatch(/\.steer-dock\s*\{[^}]*position:\s*absolute/);
    expect(css).toMatch(/\.steer-dock\s+\.sdq-list\s*\{[^}]*position:\s*absolute/);
    expect(css).toMatch(/\.steer-dock\s+\.sdq-list\s*\{[^}]*bottom:\s*100%/);
    // 浮窗内部滚动（条目多时窗内滚，不外溢——wl-items 同纪律）
    expect(css).toMatch(/\.steer-dock\s+\.sdq-list\s*\{[^}]*overflow-y:\s*auto/);
  });
});
