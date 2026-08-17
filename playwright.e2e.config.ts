/**
 * Playwright 配置（verification TS3/TS4；CL-7 E 层闭环套件——真 daemon +
 * FakeLLM，浏览器经真 WebSocket 直连）。
 *
 * 与 playwright.config.ts（F 层 mock mode）的区别：
 * - 只挑 E 层 spec（testMatch 六个文件），workers=1 串行——固定 daemon 端口
 *   5333 由各 test 独占复用（每 test 新 tmp home，串行避免端口竞争）；
 * - webServer：vite dev（基线 A，源码直跑）以 VITE_HELIX_PORT=5333 启动——
 *   构建产物/页面代码不改，仅环境变量指定 daemon 地址（禁改生产源码）；
 * - globalSetup：预检端口 + 构建 dist（VITE_HELIX_PORT=5333，基线 B 用）；
 * - 真 daemon 由 e2e/harness/daemon-fixture.ts 按 test 生命周期启停（子进程
 *   bun launcher，--home tmp），非全局守护进程。
 *
 * TR-TEST-6 连跑两轮形态：bun run test:e2e:x2（双 pass 脚本——同一配置
 * 连续跑两轮，第二轮的 CL-4-teardown-residue 断言第一轮的全量残留）。
 */
import { defineConfig, devices } from "@playwright/test";

const VITE_PORT = 5210;
const DAEMON_PORT = 5333;
const HOST = "127.0.0.1";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /(CL-7-e2e-.*|CL-6-CL-7-dual-base.*|CL-7-CL-8-restart-recovery.*|CL-1-CL-8-restart-orchestration.*|CL-2-CL-3-CL-8-restart-thinking-ledger.*|CL-4-teardown-residue.*|CL-1-e2e-.*|CL-3-e2e-.*)\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://${HOST}:${VITE_PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], locale: "zh-CN" } }],
  globalSetup: "./e2e/harness/e2e-global-setup.ts",
  webServer: {
    command: `VITE_HELIX_PORT=${DAEMON_PORT} bunx vite --host ${HOST} --port ${VITE_PORT} --strictPort`,
    cwd: "apps/shell",
    url: `http://${HOST}:${VITE_PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
