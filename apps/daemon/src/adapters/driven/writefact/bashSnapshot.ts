/**
 * bash 写感知快照器（U0b L2——IO 面：git status spawn / 受控遍历）。
 *
 * 为什么存在：L2 的断言「exec 前后快照差集 = 本命令效果」需要真实
 * 索引——git 仓内用 `git status --porcelain=v1 -z`（一条进程调用，
 * 天然跳过 ignored 产物，覆盖 M/A/D/untracked）；非 git cwd 用带预算
 * 受控遍历（时间预算硬钳制——部分索引会产生假新增，超时整面放弃）。
 * 纯逻辑（porcelain 解析/diff）在 domain/writefact/snapshotDiff.ts。
 *
 * 诚实盲区（设计文档 U0b 记录）：
 * - git status 超时（500ms）→ 该次快照 repo 面缺失 → 降级 L1 uncertain；
 * - 命令 cd 到 cwd 仓外写文件 → cwd 仓 status 覆盖不到（L1 提取路径
 *   仓外部分定向 stat 兜，提取不到则漏——L3 周期对账兜底，后续批）；
 * - 后台分离进程（nohup/&）bash 返回后才写 → 前后快照抓不到。
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { extractWriteCandidates } from "../../../domain/writefact/bashExtract";
import { parsePorcelainZ } from "../../../domain/writefact/snapshotDiff";

const execFileAsync = promisify(execFile);

/** git status 超时（单次；超时本次降级不重试）。 */
const GIT_STATUS_TIMEOUT_MS = 500;
/** 非 git 遍历软预算（超时整面放弃——部分索引会产生假新增）。 */
const WALK_BUDGET_MS = 300;
/** 遍历忽略段（与 workspace-stat-walk 同口径——重目录/运行时目录噪声面）。 */
const WALK_IGNORED = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", ".next",
  ".nuxt", "target", "coverage", ".turbo", ".cache", ".parcel-cache",
  "vendor", ".venv", "__pycache__", ".helix", ".kg", ".codegraph",
  "test-results", "evidence", ".worktrees",
]);
/** 遍历深度上限。 */
const WALK_MAX_DEPTH = 8;

/** 向上找 .git（最多 8 层）→ git 仓根；非 git → undefined。 */
export function gitRepoRootOf(cwd: string): string | undefined {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/** 快照计划（前快照时定格——后快照复用同一计划保证同口径对比）。 */
export interface BashSnapshotPlan {
  /** cwd 所在 git 仓根（非 git → undefined → walk 面）。 */
  readonly repoRoot: string | undefined;
  /** L1 提取候选中仓外绝对路径（定向 stat 兜 cwd 仓覆盖面）。 */
  readonly extraPaths: readonly string[];
  /** L1 全量候选绝对化（快照失败时的 uncertain 降级面）。 */
  readonly l1Paths: readonly string[];
}

/** L1 候选 + cwd → 快照计划（仓根探测 + 仓内外分流）。 */
export function planBashSnapshot(command: string, cwd: string): BashSnapshotPlan {
  const repoRoot = gitRepoRootOf(cwd);
  const l1Paths = extractWriteCandidates(command).map((p) => (path.isAbsolute(p) ? p : path.resolve(cwd, p)));
  const extraPaths =
    repoRoot === undefined
      ? [] // 非 git cwd：walk 面覆盖整树，extra 无意义
      : l1Paths.filter((p) => !p.startsWith(`${repoRoot}${path.sep}`));
  return { repoRoot, extraPaths, l1Paths };
}

/** 统一快照指纹索引（git: xy 状态 / walk+stat: size:mtime / 缺失: "∅"）。 */
export type BashSnapshotIndex = ReadonlyMap<string, string>;

async function gitStatusIndex(repoRoot: string): Promise<BashSnapshotIndex | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-c", "core.quotepath=off", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd: repoRoot, timeout: GIT_STATUS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    );
    const rel = parsePorcelainZ(stdout);
    const out = new Map<string, string>();
    for (const [p, xy] of rel) {
      const abs = path.join(repoRoot, p);
      if (xy === "??") {
        // untracked 的 xy 状态对内容变化不敏感（?? → ??）——追加 stat
        // 指纹补内容级敏感（新增后续改写场景：echo > f 后 sed -i f）
        try {
          const s = await stat(abs);
          out.set(abs, `g:?:${s.size}:${Math.floor(s.mtimeMs)}`);
        } catch {
          out.set(abs, "g:?");
        }
      } else {
        out.set(abs, `g:${xy}`);
      }
    }
    return out;
  } catch {
    return null; // 超时/非仓/损坏——repo 面缺失
  }
}

/** 带时间预算的受控遍历（超时返回 null 整面放弃）。 */
async function budgetWalk(root: string, budgetMs: number): Promise<BashSnapshotIndex | null> {
  const deadline = Date.now() + budgetMs;
  const out = new Map<string, string>();
  const walk = async (dir: string, depth: number): Promise<boolean> => {
    if (depth > WALK_MAX_DEPTH) return true;
    if (Date.now() > deadline) return false;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return true; // 不可读目录跳过
    }
    for (const e of entries) {
      if (WALK_IGNORED.has(e.name)) continue;
      // 符号链接不跟（防环；walkWorkspaceStats 同口径）
      if (e.isFile()) {
        const full = path.join(dir, e.name);
        try {
          const s = await stat(full);
          out.set(full, `w:${s.size}:${Math.floor(s.mtimeMs)}`);
        } catch {
          out.set(full, "w:∅");
        }
        if (Date.now() > deadline) return false;
      } else if (e.isDirectory()) {
        if (!(await walk(path.join(dir, e.name), depth + 1))) return false;
      }
    }
    return true;
  };
  return (await walk(root, 0)) ? out : null;
}

async function statPaths(paths: readonly string[]): Promise<BashSnapshotIndex> {
  const out = new Map<string, string>();
  for (const p of paths) {
    try {
      const s = await stat(p);
      out.set(p, `s:${s.size}:${Math.floor(s.mtimeMs)}`);
    } catch {
      out.set(p, "s:∅");
    }
  }
  return out;
}

/** 拍快照（plan 同口径；repo 面/walk 面/stat 面合并；面缺失记 null 标记）。 */
export interface BashSnapshot {
  readonly plan: BashSnapshotPlan;
  readonly repo: BashSnapshotIndex | null;
  readonly tree: BashSnapshotIndex | null;
  readonly extra: BashSnapshotIndex | null;
}

export async function takeBashSnapshot(plan: BashSnapshotPlan, cwd: string): Promise<BashSnapshot> {
  const repo = plan.repoRoot !== undefined ? await gitStatusIndex(plan.repoRoot) : null;
  const tree = plan.repoRoot === undefined ? await budgetWalk(path.resolve(cwd), WALK_BUDGET_MS) : null;
  const extra = plan.extraPaths.length > 0 ? await statPaths(plan.extraPaths) : null;
  return { plan, repo, tree, extra };
}

/** 前后快照差集 → 变更绝对路径（同面同键指纹不等；面从有到无 → 该面放弃不误报）。 */
export function diffBashSnapshots(before: BashSnapshot, after: BashSnapshot): readonly string[] {
  const changed = new Set<string>();
  const diffFace = (b: BashSnapshotIndex | null, a: BashSnapshotIndex | null): void => {
    if (b === null || a === null) return; // 任一面缺失（超时/降级）——放弃该面
    for (const [p, v] of a) {
      if (b.get(p) !== v) changed.add(p);
    }
    for (const p of b.keys()) {
      if (!a.has(p)) changed.add(p);
    }
  };
  diffFace(before.repo, after.repo);
  diffFace(before.tree, after.tree);
  diffFace(before.extra, after.extra);
  return [...changed];
}
