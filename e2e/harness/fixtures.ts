/**
 * e2e fixtures —— mock mode on 的统一入口（T4.4 起标准注入点）。
 *
 * 标准入口：`?fakeTransport=<script>`（URL 形态；vite webServer 经
 * VITE_HELIX_FAKE_TRANSPORT=1 启用 define 门）→ SessionProvider 经既有
 * TransportFactory 接缝装配 fake transport（apps/shell src/shared/api/
 * fake-transport.ts）——连接状态机/退避/握手全部真实跑，spec 只控制网络
 * 事件时序（控制面 window.__helixMock 由应用侧注册）。
 *
 * 三种入口 fixture（T4.4 验收：env 与 URL 双形态各自可用）：
 * - `mock`：URL 形态默认剧本 `?fakeTransport=1`（spec 手动驱动；既有 29
 *   剧本迁移后的标准形态）；
 * - `mockEnv`：env 形态（无 URL 参数，走 vite define 烘焙值）——入口 smoke
 *   消费，证明 env 形态独立可用；
 * - `mockScript`：URL 剧本模块形态（`?fakeTransport=<auto-connect 模块经
 *   vite /@fs 的 URL>`）——剧本模块 default export 自动驱动建连剧本（无需
 *   spec 手动 open/emit），入口 smoke 消费。
 *
 * 旧 addInitScript 直替方案（mock-init.ts）已删除（M6 N1）：mock 模式唯一
 * 入口 = 标准入口；mock-init.ts 仅存 DAEMON_PORT 常量。
 *
 * 其余兜底不变：dev-token HTTP 端点拦截（loopback 语义保真：CORS 放行）+
 * 外部字体离线化 + 打开 P-1 页面。
 */
import { test as base, expect, type Page } from "@playwright/test";
import * as path from "node:path";
import { DAEMON_PORT } from "./mock-init";
import { MockController } from "./mock-session";

/** vite webServer 端口（playwright.config.ts strictPort；URL 形态剧本模块经 /@fs 回源）。 */
const APP_PORT = 5199;

/** URL 剧本模块（自动建连驱动器）绝对路径（vite /@fs 可达，workspace root 内）。 */
const AUTO_CONNECT_MODULE = path.resolve(__dirname, "scripts/auto-connect.ts");

/** 离线兜底路由：dev-token 端点（§9 loopback）+ 外部字体（无网环境不阻塞渲染）。 */
async function installOfflineRoutes(page: Page): Promise<void> {
  await page.route(`**://127.0.0.1:${DAEMON_PORT}/helix-dev-token`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/plain",
      body: "e2e-dev-token",
      headers: { "access-control-allow-origin": "*" },
    });
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, async (route) => {
    await route.fulfill({ status: 200, contentType: "text/css", body: "/* e2e offline */" });
  });
}

/** 打开 P-1（mock mode 标准入口）。
 *
 * @param script fakeTransport URL 参数值；`null` = 不带参数（env 形态，
 *   define 烘焙值生效）
 */
async function openApp(page: Page, script: string | null): Promise<MockController> {
  await installOfflineRoutes(page);
  await page.goto(script === null ? "/" : `/?fakeTransport=${encodeURIComponent(script)}`);
  return new MockController(page);
}

export const test = base.extend<{
  /** URL 形态默认剧本（spec 手动驱动 __helixMock） */
  mock: MockController;
  /** env 形态（define 烘焙；无 URL 参数） */
  mockEnv: MockController;
  /** URL 剧本模块形态（auto-connect 自动驱动；spec 仅断言产物） */
  mockScript: Page;
}>({
  mock: async ({ page }, use) => use(await openApp(page, "1")),
  mockEnv: async ({ page }, use) => use(await openApp(page, null)),
  mockScript: async ({ page }, use) => {
    await installOfflineRoutes(page);
    const moduleUrl = `http://127.0.0.1:${APP_PORT}/@fs/${AUTO_CONNECT_MODULE}`;
    await page.goto(`/?fakeTransport=${encodeURIComponent(moduleUrl)}`);
    await use(page);
  },
});

export { expect };
