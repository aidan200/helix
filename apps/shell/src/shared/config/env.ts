/**
 * 运行环境配置（W7）：daemon 地址派生。
 *
 * 端口取 `VITE_HELIX_PORT`（vite env），缺省 7333（daemon DEFAULT_PORT）；
 * daemon 用随机端口（port=0）时启动日志输出实际地址，开发期可用 env 覆盖。
 */

function resolvePort(): number {
  const raw = import.meta.env.VITE_HELIX_PORT as unknown;
  const n = typeof raw === "string" ? Number(raw) : Number(raw ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 7333;
}

export const DAEMON_PORT = resolvePort();

/** WS 地址（PROTOCOL.md §1：仅 127.0.0.1 回环）。 */
export const WS_ADDR = `ws://127.0.0.1:${DAEMON_PORT}`;

// ── fake transport 标准入口（T4.4；F 层 mock mode）──────────

/** 构建期 define 原始值（"" = 未启用）。摇除锚点：define 是字面量替换，
 *  本常量在构建期即为字面量（"1" / ""），rollup 会将其内联到消费方
 *  （SessionContext 的 `FAKE_TRANSPORT_DEFINE !== ""` 分支）实现编译期
 *  分支消除——函数调用返回值不可折叠，故门控必须在常量层面而非调用层面。 */
export const FAKE_TRANSPORT_DEFINE: string =
  typeof __HELIX_FAKE_TRANSPORT__ === "string" ? __HELIX_FAKE_TRANSPORT__ : "";

/** fake transport 剧本入口解析：URL 参数与 env 双形态。
 *
 * 形态优先级：URL 参数 `?fakeTransport=<script>`（"1" = 默认剧本；或剧本
 * 模块 URL）优先；缺省回落构建期 define（`VITE_HELIX_FAKE_TRANSPORT` 烘焙，
 * vite.config.ts define → `__HELIX_FAKE_TRANSPORT__`）。
 *
 * 摇除链路（验收项：生产构建 env 未定义时 mock 零代码路径）：define 空串
 * → FAKE_TRANSPORT_DEFINE 为 "" 字面量 → SessionProvider 侧
 * `FAKE_TRANSPORT_DEFINE !== ""` 编译期折叠为 false → fakeTransportScript()
 * 调用点与 fake 模块动态 import 站点 treeshake（bundle 不含 mock）。
 */
export function fakeTransportScript(): string | null {
  if (FAKE_TRANSPORT_DEFINE === "") return null; // prod 未启用：零 URL 探测
  try {
    const p = new URLSearchParams(window.location.search).get("fakeTransport");
    if (p !== null) return p === "" ? "1" : p;
  } catch {
    /* 无 window（单测环境）防御：回落 env 形态 */
  }
  return FAKE_TRANSPORT_DEFINE;
}
