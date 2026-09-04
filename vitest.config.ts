import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * 根 vitest 配置：仅收 apps/shell 的前端单测（`bunx vitest run apps/shell`）。
 * daemon/protocol 侧测试仍走 bun test（根 script `test`），互不掺和。
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./apps/shell/src", import.meta.url)),
      "@helix/protocol": fileURLToPath(
        new URL("./packages/protocol/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["apps/shell/src/**/*.test.{ts,tsx}"],
    environment: "node",
    // TZ 钉死 Asia/Shanghai：页面时间格式化刻意用本地时区组件
    //（fmtLastUsedAt/fmtSyncedAt 等，产品语义 = 用户本地时间），测试期望
    // 字面量按 +08:00  fixture 书写——不钉 TZ 时 CI（UTC runner）渲染值
    // 偏移 8h 假红（WorkspaceGatePage 实锤：期望 14:32 渲染 06:32）。
    // 开发机本就在 +08:00，钉死对本地零行为变化。
    env: { TZ: "Asia/Shanghai" },
  },
});
