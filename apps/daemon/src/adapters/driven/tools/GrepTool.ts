import type {
  AgentHarnessTool,
  AgentToolResult,
  ExecutionEnv,
  ExecutionToolContext,
} from "@earendil-works/pi-agent-core/node";
import { getOrThrow } from "@earendil-works/pi-agent-core/node";

/**
 * GrepTool —— 自写 grep 工具（F(5).1 标准 2，AD-10）。
 *
 * 分两半（test-design TP-CL5-2）：
 * - **匹配核心 = 纯函数**（本文件上半区）：输入内存数据（文件清单 +
 *   查询），输出命中行列表；零 fs/node API、零框架依赖，可单测。
 * - **文件遍历 = 薄封装**（下半区）：走注入的 ExecutionEnv（与 core
 *   四工具同一沙箱 cwd），只做「路径 → GrepFile[]」的取数，不含匹配逻辑。
 *
 * 实现的是 core 的 Tool 接口家族（AgentHarnessTool：execute 多一个
 * context 参数，经 bindToolContext 绑定后即 AgentTool，装配在
 * CoreToolExecutor）。参数 schema 为手写 JSON Schema（与 typebox
 * Type.Object 产物同构，pi-ai 校验层兼容；daemon 不直接依赖 typebox）。
 */

// ── 匹配核心（纯函数区，framework-free） ────────────────────

/** 单文件的纯数据投影（路径 + 按行拆分的内容）。 */
export interface GrepFile {
  readonly path: string;
  readonly lines: readonly string[];
}

/** 一次命中：文件 + 1-based 行号 + 行原文。 */
export interface GrepMatch {
  readonly path: string;
  readonly lineNumber: number;
  readonly line: string;
}

/** 匹配查询：子串 pattern + 可选 glob 路径过滤 + 大小写开关。 */
export interface GrepQuery {
  readonly pattern: string;
  readonly glob?: string;
  readonly ignoreCase?: boolean;
}

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

// ── 工具封装（AgentHarnessTool：遍历薄封装 + 纯匹配核） ──────────

/** grep 工具参数（JSON Schema，手写；见文件头注释）。 */
const grepParameters = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "搜索的子串（区分大小写，除非 ignoreCase）" },
    path: { type: "string", description: "搜索起点：文件或目录（相对当前工作目录）" },
    glob: { type: "string", description: "文件路径过滤 glob（* 可跨目录，如 *.ts）" },
    ignoreCase: { type: "boolean", description: "忽略大小写（默认 false）" },
  },
  required: ["pattern", "path"],
  additionalProperties: false,
} as const;

/** 遍历上限（防失控扫描；超出即报错提示收窄 path/glob）。 */
const MAX_FILES = 1000;
/** 跳过的高噪音目录（node_modules/.git——JS 仓库内递归 grep 的实用默认）。 */
const SKIP_DIRS = new Set(["node_modules", ".git"]);

/** 自写 grep 工具：实现 core 的 Tool 接口（AgentHarnessTool 形态）。 */
export function createGrepTool(): AgentHarnessTool<ExecutionToolContext, any, undefined> {
  return {
    name: "grep",
    label: "grep",
    description:
      "在指定文件或目录内递归搜索文本（子串匹配），返回命中行（格式 path:行号: 行内容）。" +
      "可用 glob 过滤文件（* 可跨目录）、ignoreCase 忽略大小写。跳过 node_modules 与 .git。",
    parameters: grepParameters as any,
    async execute(toolCallId, params, signal, _onUpdate, context): Promise<AgentToolResult<undefined>> {
      void toolCallId;
      const { pattern, path, glob, ignoreCase } = params as {
        pattern: string;
        path: string;
        glob?: string;
        ignoreCase?: boolean;
      };
      const files = await collectGrepFiles(context.env, path, signal);
      const matches = matchFiles(files, { pattern, glob, ignoreCase });
      const text =
        matches.length > 0
          ? matches.map((m) => `${m.path}:${m.lineNumber}: ${m.line}`).join("\n")
          : `(no matches for "${pattern}")`;
      return { content: [{ type: "text", text }], details: undefined };
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
