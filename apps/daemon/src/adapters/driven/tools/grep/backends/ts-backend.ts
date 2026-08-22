import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { getOrThrow } from "@earendil-works/pi-agent-core/node";
import type { GrepBackend, GrepFile, GrepMatch, GrepQuery } from "../contract";

/**
 * 内置 TS 后端（CL-3 恒在兜底）——自旧 GrepTool.ts 机械迁移，**匹配核
 * 逻辑零改动**（含空 pattern 报错语义；arch-guard TP-CL5-2-A 守护本文件
 * 无 node/fs import，遍历只经注入的 ExecutionEnv）。
 *
 * 分两半（test-design）：
 * - **匹配核心 = 纯函数**（上半区）：输入内存数据（文件清单 + 查询），
 *   输出命中行列表；零 fs/node API、零框架依赖，可单测。
 * - **文件遍历 = 薄封装**（下半区）：走注入的 ExecutionEnv（与 core
 *   四工具同一沙箱 cwd），只做「路径 → GrepFile[]」的取数，不含匹配逻辑。
 */

// ── 匹配核心（纯函数区，framework-free） ────────────────────

/**
 * 匹配核心：files × query → 命中行列表（按输入文件/行序稳定输出）。
 * 子串匹配（grep -F 语义）；glob 为空即不过滤。
 */
export function matchFiles(files: readonly GrepFile[], query: GrepQuery): GrepMatch[] {
  if (query.pattern === "") {
    throw new Error("grep pattern 不能为空字符串（会命中所有行，属误用）");
  }
  const globRe = query.glob === undefined ? undefined : globToRegExp(query.glob);
  const needle = query.ignoreCase === true ? query.pattern.toLowerCase() : query.pattern;
  const matches: GrepMatch[] = [];
  for (const file of files) {
    if (globRe !== undefined && !globRe.test(file.path)) continue;
    for (let i = 0; i < file.lines.length; i++) {
      const line = file.lines[i] as string;
      const haystack = query.ignoreCase === true ? line.toLowerCase() : line;
      if (haystack.includes(needle)) {
        matches.push({ path: file.path, lineNumber: i + 1, line });
      }
    }
  }
  return matches;
}

/**
 * glob → 正则（`*` 可跨目录——grep --include 的 fnmatch 语义；
 * `?` 单字符；其余字符按字面量转义）。
 */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob.charAt(i);
    if (ch === "*") source += ".*";
    else if (ch === "?") source += ".";
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

// ── 后端封装（GrepBackend：遍历薄封装 + 纯匹配核） ─────────────

/** 遍历上限（防失控扫描；超出即报错提示收窄 path/glob）。 */
const MAX_FILES = 1000;
/** 跳过的高噪音目录（node_modules/.git——JS 仓库内递归 grep 的实用默认）。 */
const SKIP_DIRS = new Set(["node_modules", ".git"]);

/**
 * 内置 TS 后端：构造面注入遍历环境（env/根路径/signal），search 只消费
 * 查询（contract.ts GrepBackend 形状）。T1.1 为唯一后端（门面直挂）；
 * rg 后端与后端选择/降级编排见 T1.2/T1.3。
 */
export function createTsBackend(env: ExecutionEnv, rootPath: string, signal?: AbortSignal): GrepBackend {
  return {
    name: "ts",
    async search(query: GrepQuery): Promise<GrepMatch[]> {
      const files = await collectGrepFiles(env, rootPath, signal);
      return matchFiles(files, query);
    },
  };
}

// ── 文件遍历（薄封装：env 取数 → GrepFile 投影） ─────────────

/** 递归收集 path 下的可读文本文件（相对 cwd 的路径投影）。 */
async function collectGrepFiles(
  env: ExecutionEnv,
  rootPath: string,
  signal?: AbortSignal,
): Promise<GrepFile[]> {
  const absRoot = getOrThrow(await env.absolutePath(rootPath));
  const info = getOrThrow(await env.fileInfo(absRoot));
  const paths: string[] = [];
  if (info.kind === "file") {
    paths.push(info.path);
  } else if (info.kind === "directory") {
    await walkDir(env, info.path, paths, signal);
  } else {
    throw new Error(`grep 路径既非文件也非目录：${rootPath}`);
  }
  if (paths.length > MAX_FILES) {
    throw new Error(`grep 扫描文件数超过上限 ${MAX_FILES}，请收窄 path 或加 glob 过滤`);
  }
  const files: GrepFile[] = [];
  for (const abs of paths) {
    const text = await env.readTextFile(abs, signal); // Result：二进制/解码失败 → 跳过
    if (!text.ok) continue;
    files.push({ path: relativeToCwd(env.cwd, abs), lines: text.value.split("\n") });
  }
  return files;
}

/** 深度优先遍历目录（跳过 SKIP_DIRS；上限保护）。 */
async function walkDir(
  env: ExecutionEnv,
  dirPath: string,
  out: string[],
  signal?: AbortSignal,
): Promise<void> {
  if (out.length > MAX_FILES) return;
  const entries = getOrThrow(await env.listDir(dirPath, signal));
  for (const entry of entries) {
    if (entry.kind === "directory") {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walkDir(env, entry.path, out, signal);
    } else if (entry.kind === "file") {
      out.push(entry.path);
    }
  }
}

/** 绝对路径 → cwd 相对投影（不在 cwd 下则原样输出）。 */
function relativeToCwd(cwd: string, absPath: string): string {
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;
}
