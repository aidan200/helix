/**
 * TC1.1 —— Playwright 基座冒烟（TS1；CL-7）。
 *
 * mock mode on：fake transport 建连（welcome+snapshot）后，P-1 应用壳渲染
 * —— header 与 composer 存在、状态条 connected。证据：截图 + trace。
 */
import { test, expect } from "./harness/fixtures";
import { shotEvidence } from "./harness/evidence";

test.describe("CL-7 smoke（mock mode on）", () => {
  test("P-1 页面打开，app 壳渲染（header/composer），mock 建连到 connected", async ({ mock, page }) => {
    // 首连初始即 connecting（SM-2：open → connecting）
    await expect(mock.app()).toHaveAttribute("data-conn", "connecting");

    // 标准剧本：open → hello → welcome → snapshot
    await mock.connect();

    // app 壳：header + composer
    await expect(page.locator(".app-header")).toBeVisible();
    await expect(page.locator(".composer-wrap")).toBeVisible();
    await expect(page.locator("#msg-input")).toBeVisible();

    // hello 首帧契约（握手）：token + protocolVersion（v0.3 bump 机械跟随；契约 = PROTOCOL.md §2/§12）
    const hello = await mock.waitForCommand("hello");
    expect(hello.payload).toEqual({ token: "e2e-dev-token", protocolVersion: "0.4" });

    // 状态条 label = 已连接（zh-CN 默认包）
    await expect(page.locator(".conn-status")).toContainText("已连接");

    await shotEvidence(page, "smoke");
  });
});
