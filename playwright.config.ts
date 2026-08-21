/**
 * Playwright 配置（verification TS1；CL-7 F 层还原度套件）。
 *
 * - webServer：vite dev（源码直跑，验证待合并 dev 代码），--host 127.0.0.1
 *   + strictPort 5199（显式 IPv4 loopback，避免 localhost 解析到 ::1 时
 *   探测失败）；VITE_HELIX_FAKE_TRANSPORT=1 启用 fake transport 标准入口
 *   define 门（T4.4：env 形态默认剧本 + ?fakeTransport=<url> URL 形态）；
 *   mock mode 下无 daemon（fake transport 注入 + dev-token 端点 HTTP 拦截，
 *   见 e2e/harness/）。
 * - trace retain-on-failure；截图证据由各 spec 显式落 evidence/e2e/。
 */
import { defineConfig, devices } from "@playwright/test";

const PORT = 5199;
const HOST = "127.0.0.1";

export default defineConfig({
  testDir: "./e2e",
  // E 层套件（真 daemon + FakeLLM）归 playwright.e2e.config.ts 专属入口
  // （需 VITE_HELIX_PORT=5333 的 vite 与 daemon fixture），默认入口只跑 F 层。
  testIgnore: /(CL-7-e2e-.*|CL-6-CL-7-dual-base.*|CL-7-CL-8-restart-recovery.*|CL-1-CL-8-restart-orchestration.*|CL-2-CL-3-CL-8-restart-thinking-ledger.*|CL-4-teardown-residue.*|CL-1-e2e-.*|CL-2-e2e-.*|CL-3-e2e-.*|CL-5-e2e-.*|CL-skills-e2e-.*)\.spec\.ts/,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  retries: 0,
  workers: 4,
  reporter: [["list"]],
  use: {
    baseURL: `http://${HOST}:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], locale: "zh-CN" } }],
  webServer: {
    command: `VITE_HELIX_FAKE_TRANSPORT=1 bunx vite --host ${HOST} --port ${PORT} --strictPort`,
    cwd: "apps/shell",
    url: `http://${HOST}:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
