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
    // W6o 首启 boot 门禁：建连前恒显 boot 屏（full 序列 + 活状态行），
    // 应用壳（.app）在「连接就绪 + 序列播完」双条件齐备前不渲染
    await expect(page.locator('[data-wsgate-boot="connecting"]')).toBeVisible();
    await expect(page.locator('[data-wsgate-boot="connecting"]')).toContainText("connecting daemon…");

    // 标准剧本：open → hello → welcome → snapshot（fake transport 自动应答
    // workspace.get 预绑定 → 门禁 main → boot hold 收口 → 应用壳）
    await mock.connect();

    // app 壳：header + composer
    await expect(page.locator(".app-header")).toBeVisible();
    await expect(page.locator(".composer-wrap")).toBeVisible();
    await expect(page.locator("#msg-input")).toBeVisible();

    // hello 首帧契约（握手）：token + protocolVersion（v0.11 bump 机械跟随——thinking 批
    // T1.1 版本位 v0.11；契约 = PROTOCOL.md §2/§17.11）
    const hello = await mock.waitForCommand("hello");
    expect(hello.payload).toEqual({ token: "e2e-dev-token", protocolVersion: "0.11" });

    // 状态条 label = 已连接（zh-CN 默认包）
    await expect(page.locator(".conn-status")).toContainText("已连接");

    await shotEvidence(page, "smoke");
  });
});
