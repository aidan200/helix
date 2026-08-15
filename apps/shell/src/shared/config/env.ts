/**
 * 运行环境配置（W7）：daemon 地址派生。
 *
 * 端口取 `VITE_HELIX_PORT`（vite env），缺省 7333（daemon DEFAULT_PORT）；
 * daemon 用随机端口（port=0）时启动日志输出实际地址，开发期可用 env 覆盖。
 */

/** dev token 端点路径（PROTOCOL.md §9；与 daemon WsServerAdapter.DEV_TOKEN_PATH 对齐）。 */
export const DEV_TOKEN_PATH = "/helix-dev-token";

function resolvePort(): number {
  const raw = import.meta.env.VITE_HELIX_PORT as unknown;
  const n = typeof raw === "string" ? Number(raw) : Number(raw ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 7333;
}

export const DAEMON_PORT = resolvePort();

/** WS 地址（PROTOCOL.md §1：仅 127.0.0.1 回环）。 */
export const WS_ADDR = `ws://127.0.0.1:${DAEMON_PORT}`;

/** dev token 获取地址（HTTP 面，loopback Origin 反射放行）。 */
export const DEV_TOKEN_URL = `http://127.0.0.1:${DAEMON_PORT}${DEV_TOKEN_PATH}`;

/** 开发模式（原型演示控制台等按 isDev 门控；prod 不渲染）。 */
export function isDev(): boolean {
  return Boolean(import.meta.env.DEV);
}
