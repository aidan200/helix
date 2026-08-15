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
  },
});
