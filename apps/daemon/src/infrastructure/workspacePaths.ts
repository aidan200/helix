import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * workspace 运行物料根（落点规范批，2026-10-10）。
 *
 * 语义二分（与 paths.ts 的 home 单点对偶）：
 * - `~/.helix/`（paths.ts 单点派生）= 本**用户**的 helix 全局状态——凭据/
 *   领域库/记忆/技能/模型/日志，跨 workspace 共享；
 * - `<workspaceRoot>/.helix/` = 本 **workspace** 的 helix 运行物料——临时
 *   暂存与工具链缓存，可再生、可回收，删 workspace 即全清。
 *
 * 「当前目录」的根语义 = 各执行面的工作根（主会话 toolCwd / SubAgent
 * toolCwd（isolated 实例 = worktree 路径）/ MCP config.cwd），与 toolCwd
 * 同源——不引入新的绑定概念。
 *
 * 生命周期标记（为回收逻辑预留）：`tmp/` 短命暂存可随时清；`tool-cache/`
 * 纯缓存可再生可清。目录名即回收面枚举。
 *
 * 落点纪律（AG-19）：daemon src 内不得直接调用系统 tmpdir 落暂存文件
 * （政策面豁免见 sandboxSetup——沙箱可写根追加是「允许写」语义）；
 * 子进程暂存一律经本单点或 TMPDIR 注入归位 workspace 物料根。
 */

/** workspace 物料目录名（与 ~/.helix 同名不同父，语义靠父路径区分）。 */
export const WORKSPACE_MATERIALS_DIRNAME = ".helix";

/** 短命暂存统一根：`<workspaceRoot>/.helix/tmp`。 */
export function resolveWorkspaceTmp(workspaceRoot: string): string {
  return path.join(workspaceRoot, WORKSPACE_MATERIALS_DIRNAME, "tmp");
}

/** 确保暂存根存在（mkdtemp 需要父目录在场）并返回路径。 */
export function ensureWorkspaceTmp(workspaceRoot: string): string {
  const dir = resolveWorkspaceTmp(workspaceRoot);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 工具链缓存重定向清单（A 方案，原 sandboxSetup 单点迁此）：env 键 →
 * tool-cache 子目录名。只收「纯缓存」类（重定向不破坏已有安装面）——
 * CARGO_HOME/GOPATH 类混放 bin/安装物的键不收。
 */
const TOOL_CACHE_DIRS: Record<string, string> = {
  UV_CACHE_DIR: "uv",
  npm_config_cache: "npm",
  PIP_CACHE_DIR: "pip",
  BUN_INSTALL_CACHE_DIR: "bun",
};

/**
 * 工具链用户级缓存 env 重定向到 `<workspaceRoot>/.helix/tool-cache/*`——
 * helix 拉起的子进程（bash/MCP server）不再把缓存散落到用户级缺省位
 * （~/.cache/uv、~/.npm 等）；包管理器自建缓存目录，此处不做 mkdir。
 */
export function toolCacheEnvFor(workspaceRoot: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(TOOL_CACHE_DIRS).map(([key, dir]) => [
      key,
      path.join(workspaceRoot, WORKSPACE_MATERIALS_DIRNAME, "tool-cache", dir),
    ]),
  );
}

/**
 * 子进程环境注入集（bash shellEnv / SubAgent spawn env / MCP spawn env
 * 共用）：TMPDIR 指向暂存根（mktemp 类命令与系统 tmpdir 消费方归位）+
 * 工具链缓存重定向四键。调用方语义 = 「helix 管理的子进程统一落点」；
 * merge 序中低优先（显式 options.env / config.env 覆盖兑底）。
 *
 * 容错降级：暂存根不可建（根已消亡/只读/测试假路径）时 TMPDIR 不注入
 * （子进程回落继承系统缺省），缓存键仍指物料根——包管理器自建缓存目录。
 */
export function workspaceChildEnv(workspaceRoot: string): Record<string, string> {
  const env: Record<string, string> = { ...toolCacheEnvFor(workspaceRoot) };
  try {
    env.TMPDIR = ensureWorkspaceTmp(workspaceRoot);
  } catch {
    // 根不可建——TMPDIR 回落继承（见上）；不阻断调用方
  }
  return env;
}
