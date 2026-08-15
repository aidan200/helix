/**
 * E 层 globalSetup（TS3/TS4）：
 * 1. 预检：E 层 daemon 端口（5333）未被占用（占用即 fail-fast，避免误连
 *    环境里的其他服务）；
 * 2. 构建前端静态产物（VITE_HELIX_PORT=5333 烘焙 daemon 地址）——dist 属
 *    构建输出（.gitignore 已忽略），非生产源码，TC3.4 基线 B（daemon
 *    static serve）复用该产物。HELIX_E2E_SKIP_BUILD=1 可跳过（产物已在）。
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

const WORKTREE_ROOT = path.resolve(__dirname, "..", "..");
const DAEMON_PORT = 5333;
const SHELL_DIR = path.join(WORKTREE_ROOT, "apps", "shell");
const DIST = path.join(SHELL_DIR, "dist");

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

export default async function globalSetup(): Promise<() => Promise<void> | void> {
  if (await portInUse(DAEMON_PORT)) {
    throw new Error(
      `E 层 daemon 端口 127.0.0.1:${DAEMON_PORT} 已被占用——E 层套件需要独占该端口（真实 daemon 串行复用）。`,
    );
  }

  const skipBuild = process.env.HELIX_E2E_SKIP_BUILD === "1";
  const distReady = () => fs.existsSync(path.join(DIST, "index.html"));
  if (!skipBuild || !distReady()) {
    execSync(`VITE_HELIX_PORT=${DAEMON_PORT} bun run build`, {
      cwd: SHELL_DIR,
      stdio: "inherit",
    });
  }
  if (!distReady()) {
    throw new Error(`静态产物缺失：${DIST}/index.html 不存在（构建失败？）`);
  }
  return undefined;
}
