import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * workspace 项目扫描与归属（§3.5 一级目录语义，T3.3 抽取自
 * buildKnowledgeStack——组合根与 SubAgent 子进程（ChildMain 本地 kg 栈）
 * 共用同一扫描口径；单点正式收口归 T5.x project-discovery）。
 *
 * §3.5 宽松口径 V-3：workspace 一级目录全部入列，排除清单为唯一过滤
 * （目录项、非隐藏、非排除段）——不做目录资格甄别。
 */

/** §3.5 排除清单（scanWorkspaceProjects 与事件归属共用唯一过滤）。 */
export const WORKSPACE_EXCLUDED: ReadonlySet<string> = new Set(["docs", ".helix", ".worktrees", "node_modules"]);

export function scanWorkspaceProjects(workspaceRoot: string): string[] {
  let entries;
  try {
    entries = readdirSync(workspaceRoot, { withFileTypes: true });
  } catch {
    return []; // workspace 根不可读——无项目可触发
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || WORKSPACE_EXCLUDED.has(entry.name)) continue;
    out.push(path.join(workspaceRoot, entry.name));
  }
  return out.sort();
}

/**
 * 文件 → 项目根归属（§3.5 一级目录语义，T3.2）：workspace 内一级目录即
 * projectRoot；排除清单/隐藏段/根外文件 → undefined（不属任何项目域）。
 * 启动扫描与事件归属（watch/edit 挂点）共用同一过滤口径。
 */
export function projectRootOfPath(workspaceRoot: string, absPath: string): string | undefined {
  const rel = path.relative(workspaceRoot, absPath);
  if (rel === "" || path.isAbsolute(rel) || rel.startsWith("..")) return undefined;
  const first = rel.split(path.sep)[0] ?? "";
  if (first === "" || first.startsWith(".") || WORKSPACE_EXCLUDED.has(first)) return undefined;
  return path.join(workspaceRoot, first);
}

/**
 * 已建 .kg 索引的项目（有序）：kg 读面（search/get/切片注入）的项目域
 * ——读面绝不新建库文件（未建 .kg 的项目不可见；写面 createNode 仍可
 * 在 scanProjects 全集内建库）。
 */
export function existingKgProjects(workspaceRoot: string): string[] {
  return scanWorkspaceProjects(workspaceRoot).filter((projectRoot) =>
    existsSync(path.join(projectRoot, ".kg", "kg.db")),
  );
}
