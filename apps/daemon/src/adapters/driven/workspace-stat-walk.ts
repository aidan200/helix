import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { WorkspaceStatIndexLite } from "../../application/services/TurnDiffService";

/**
 * workspace 递归 stat 索引（T2 turn diff external 兜底——轮首/轮末各
 * walk 一次，TurnDiffService 对比记 external 条目）。
 *
 * 只读、忽略重目录段（node_modules/.git 等）、不跟符号链接（withFileTypes
 * 的 isFile/isDirectory 对 symlink 均假——天然防环）、深度上限防御。
 * 与 workspace-scan.ts（kg 项目扫描）同层同风格但口径独立：本 walk 是
 * 全文件 stat 索引，不做一级目录资格甄别。
 */

/** walk 忽略段（重目录——索引成本与噪声面控制；浮窗批 v3：补 daemon 自产面
 * .helix/.kg/.codegraph（运行时目录——轮内高频变化，纯噪声）与
 * test-results/evidence（测试产物段，名字特异误伤面可忽略）。）。 */
export const STAT_WALK_IGNORED_SEGMENTS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  "target",
  "coverage",
  ".turbo",
  ".cache",
  ".parcel-cache",
  "vendor",
  ".venv",
  "__pycache__",
  ".helix",
  ".kg",
  ".codegraph",
  "test-results",
  "evidence",
]);

/** 数据库文件后缀（helix.db* 等本地库——轮内持续写库，size 噪声源）。 */
const STAT_WALK_IGNORED_SUFFIXES: readonly string[] = [
  ".db",
  ".db-wal",
  ".db-shm",
  ".sqlite",
  ".sqlite3",
];

/** 深度上限（防病态深路径）。 */
const STAT_WALK_MAX_DEPTH = 16;

/** 递归 walk：root 下全部文件（忽略段外）→ path → {mtimeMs,size}。 */
export async function walkWorkspaceStats(root: string): Promise<WorkspaceStatIndexLite> {
  const index: WorkspaceStatIndexLite = new Map();
  await walkDir(root, index, 0);
  return index;
}

async function walkDir(dir: string, index: WorkspaceStatIndexLite, depth: number): Promise<void> {
  if (depth > STAT_WALK_MAX_DEPTH) return;
  let entries: Dirent[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as unknown as Dirent[];
  } catch {
    return; // 目录不可读（权限/并发删除）——跳过
  }
  for (const entry of entries) {
    if (STAT_WALK_IGNORED_SEGMENTS.has(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(p, index, depth + 1);
    } else if (entry.isFile()) {
      if (STAT_WALK_IGNORED_SUFFIXES.some((sfx) => entry.name.endsWith(sfx))) continue;
      try {
        const s = await stat(p);
        index.set(p, { mtimeMs: s.mtimeMs, size: s.size });
      } catch {
        /* 并发删除：跳过 */
      }
    }
  }
}
