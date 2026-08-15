/**
 * e2e fixtures —— mock mode on 的统一入口。
 *
 * 自动完成：fake WebSocket 注入（先于应用代码）+ dev-token HTTP 端点拦截
 * （loopback 语义保真：CORS 放行）+ 外部字体离线化 + 打开 P-1 页面。
 */
import { test as base, expect } from "@playwright/test";
import { DAEMON_PORT, MOCK_INIT_SCRIPT } from "./mock-init";
import { MockController } from "./mock-session";

export const test = base.extend<{ mock: MockController }>({
  mock: async ({ page }, use) => {
    await page.addInitScript({ content: MOCK_INIT_SCRIPT });

    // dev-token 端点（§9 loopback）：mock mode 下由 route 兜底，无 daemon
    await page.route(`**://127.0.0.1:${DAEMON_PORT}/helix-dev-token`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/plain",
        body: "e2e-dev-token",
        headers: { "access-control-allow-origin": "*" },
      });
    });

    // 外部字体离线化（避免无网环境阻塞渲染）
    await page.route(/fonts\.(googleapis|gstatic)\.com/, async (route) => {
      await route.fulfill({ status: 200, contentType: "text/css", body: "/* e2e offline */" });
    });

    await page.goto("/");
    await use(new MockController(page));
  },
});

export { expect };
