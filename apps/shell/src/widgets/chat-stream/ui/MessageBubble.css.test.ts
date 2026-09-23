/**
 * 消息行对齐与徽标排布 CSS 纪律测试（对齐一致性批；node 环境直读样式表——
 * jsdom 不加载 CSS，仿 ChatStatusBar.css.test.ts 直读模式）。
 *
 * 钉纪律（对齐契约：谁说的话在哪侧）：
 * - user 气泡右对齐：.msg.user row-reverse（头像居右，右上小角朝头像侧），
 *   .msg.user .col 右贴齐（align-items:flex-end）——修复前 user 气泡左对齐
 *   与右上小角方向相悖的不协调；
 * - assistant 气泡左对齐（缺省 .msg 布局，不另设规则——本测试钉「无
 *   row-reverse 混入 assistant 侧」防回归）；
 * - 系统侧内联状态卡左对齐：engine-error-card / ee-group / network-retry-card /
 *   ask-card 一律 margin-right:auto（修复前 margin-left:auto 右对齐——
 *   系统产出与 assistant 同侧，不与 user 气泡抢右侧语义）；
 * - 气泡徽标横排：.bubble-badges flex-direction:row（steer 两态 + 管家来源
 *   徽标一行，不随 .col 竖向堆叠）；
 * - 骨架同构：workbench.css .skel-row.user 同款 row-reverse（P-1s 切换骨架
 *   与终态布局同构的既有纪律）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const appCss = readFileSync(
  fileURLToPath(new URL("../../../shared/ui/styles/app.css", import.meta.url)),
  "utf8",
);
const wbCss = readFileSync(
  fileURLToPath(new URL("../../../shared/ui/styles/workbench.css", import.meta.url)),
  "utf8",
);

describe("消息行对齐 CSS 纪律（user 右 / assistant 左 / 系统状态卡左）", () => {
  it("user 行右对齐：.msg.user row-reverse（头像居右）", () => {
    expect(appCss).toMatch(/\.msg\.user\s*\{[^}]*flex-direction:\s*row-reverse/);
  });

  it("user col 右贴齐：meta/徽标/气泡按内容宽右对齐", () => {
    expect(appCss).toMatch(/\.msg\.user\s+\.col\s*\{[^}]*align-items:\s*flex-end/);
  });

  it("assistant 行保持左对齐：无 row-reverse 混入", () => {
    expect(appCss).not.toMatch(/\.msg\.assistant\s*\{[^}]*row-reverse/);
  });

  it("系统侧内联状态卡左对齐：四卡族 margin-right:auto 且无 margin-left:auto", () => {
    for (const cls of [".engine-error-card", ".ee-group", ".network-retry-card", ".ask-card"]) {
      expect(appCss, `${cls} 应 margin-right:auto 左对齐`).toMatch(
        new RegExp(`${cls.replace(".", "\\.")}\\s*\\{[^}]*margin-right:\\s*auto`),
      );
      expect(appCss, `${cls} 不得残留 margin-left:auto`).not.toMatch(
        new RegExp(`${cls.replace(".", "\\.")}\\s*\\{[^}]*margin-left:\\s*auto`),
      );
    }
  });

  it("气泡徽标横排：.bubble-badges 为行向 flex", () => {
    expect(appCss).toMatch(/\.bubble-badges\s*\{[^}]*display:\s*flex/);
    expect(appCss).toMatch(/\.bubble-badges\s*\{[^}]*flex-direction:\s*row/);
  });

  it("骨架同构：.skel-row.user 与终态同款右对齐（row-reverse）", () => {
    expect(wbCss).toMatch(/\.skel-row\.user\s*\{[^}]*flex-direction:\s*row-reverse/);
  });
});
