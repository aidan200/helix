/**
 * vite 配置（W7/CL-7）。
 *
 * - `@` → src（FSD 别名）；
 * - `@helix/protocol` → packages/protocol 源码：bun workspace 在本仓未落
 *   node_modules 物理链接，且 vite 不读 tsconfig paths，故用显式 resolve.alias
 *   （AG-13 两端同源的构建侧接线）。
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
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
