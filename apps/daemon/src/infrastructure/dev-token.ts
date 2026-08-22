import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * dev token 文件机制（architecture.md §6.1/§7.1）。
 *
 * daemon 每次启动生成随机 token 并**重写** `<home>/dev-token`（0600）：
 * - 重写而非复用：token 是本次进程的会话凭证，重启即轮换；
 * - 多 daemon 并存由单例锁（AG-17）排除，不存在「两个 daemon 谁的 token 算数」；
 * - 浏览器侧获取通道 = daemon HTTP 端点 GET /helix-dev-token（仅 127.0.0.1
 *   监听 + loopback Origin 反射；机制成文见 packages/protocol/PROTOCOL.md §9）。
 */
export const DEV_TOKEN_FILE_MODE = 0o600;

/** 生成随机 token、写入 devTokenPath 并返回（daemon 内存持有 = WS 握手比对源）。 */
export function ensureDevToken(devTokenPath: string): string {
  const token = randomBytes(24).toString("hex");
  mkdirSync(path.dirname(devTokenPath), { recursive: true });
  writeFileSync(devTokenPath, token, "utf8");
  chmodSync(devTokenPath, DEV_TOKEN_FILE_MODE);
  return token;
}
