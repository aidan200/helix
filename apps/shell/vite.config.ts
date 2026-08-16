/**
 * vite 配置（W7/CL-7）。
 *
 * - `@` → src（FSD 别名）；
 * - `@helix/protocol` → packages/protocol 源码：bun workspace 在本仓未落
 *   node_modules 物理链接，且 vite 不读 tsconfig paths，故用显式 resolve.alias
 *   （AG-13 两端同源的构建侧接线）；
 * - define `__HELIX_FAKE_TRANSPORT__`（T4.4）：F 层 mock mode 标准入口的
 *   构建期开关，取 `VITE_HELIX_FAKE_TRANSPORT`（F 层 playwright webServer
 *   以 =1 启用；生产/E 层构建不设 → 空串 → SessionProvider 分支常量折叠，
 *   fake 模块零代码路径）。
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  define: {
    __HELIX_FAKE_TRANSPORT__: JSON.stringify(process.env.VITE_HELIX_FAKE_TRANSPORT ?? ""),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@helix/protocol": fileURLToPath(
        new URL("../../packages/protocol/src/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
