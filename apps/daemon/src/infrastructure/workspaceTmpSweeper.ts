import { readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { Logger } from "./logging";
import { resolveWorkspaceTmp } from "./workspacePaths";

/**
 * workspace tmp 机械清仓（清理纪律批 2026-10-21，机械面；kg 节点 TR-301）。
 *
 * agent 行为纪律（engineering.md ①尾）管「任务收口删自建」，本模块是
 * daemon 侧兜底回收：定时扫 `<workspaceRoot>/.helix/tmp/` 下**过龄**条目
 * 整删——两层互补，agent 忘删也不无限累积。
 *
 * 判据与边界（TR-301 条款对齐）：
 * - 年龄 = 条目树内**最新** mtime（目录深层写入不触父目录 mtime，取树内
 *   max 才不会误删「顶层老但最近在用」的暂存目录）；扫描条目数有预算
 *   上限，超限停深入用已见 max（防异常大目录拖垮扫描）。
 * - 只清当前绑定 workspace 的 tmp 根（WorkspaceService.boundRoot 每轮取
 *   现值，rebind 天然跟随）；不动 tool-cache/（可再生缓存）与
 *   .worktrees/（随 worktree 生命周期）——单点枚举见 workspacePaths。
 * - 过龄阈值 7 天：TR-301 留存例外（跨任务对照基准等）的显式留存窗口；
 *   单条目删除失败（EBUSY 等）warn 跳过不阻断整轮。
 */
export const TMP_SWEEP_FIRST_DELAY_MS = 60_000;
export const TMP_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const TMP_SWEEP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** 单轮扫描 stat 预算（条目计数；超限停止深入，防异常大目录）。 */
export const TMP_SWEEP_MAX_SCAN_ENTRIES = 5000;

/** 一轮清仓结果（可观测面：info 汇总行 + 测试断言）。 */
export interface TmpSweepResult {
  /** 已删除的顶层条目名（basename）。 */
  readonly removed: readonly string[];
  /** 保留（未过龄）条目数。 */
  readonly kept: number;
  /** 删除失败条目名（warn 已记，不阻断）。 */
  readonly failed: readonly string[];
}

/** 扫描面参数（全可选注入——缺省即生产常量；测试面收窄）。 */
export interface SweepOptions {
  /** 过龄阈值毫秒。 */
  readonly maxAgeMs?: number;
  /** 扫描条目预算上限。 */
  readonly maxScanEntries?: number;
  /** 删除实现（缺省 rmSync recursive+force；测试注入失败/观察）。 */
  readonly rm?: (p: string) => void;
  /** 删除失败 warn 出口（缺省静默——纯函数面不持 logger）。 */
  readonly onRemoveError?: (name: string, reason: unknown) => void;
}

/** 条目树内最新 mtime（毫秒）；预算耗尽用已见 max，stat 失败按 0 龄处理
 * （保守：探测不到的条目视为过龄候选，交由 rm 的 force/try 兜底）。 */
function newestMtimeMs(p: string, budget: { left: number }): number {
  let st;
  try {
    st = statSync(p);
  } catch {
    return 0;
  }
  let newest = st.mtimeMs;
  if (!st.isDirectory()) return newest;
  let entries: string[];
  try {
    entries = readdirSync(p);
  } catch {
    return newest; // 目录不可读：年龄退化为自身 mtime
  }
  for (const name of entries) {
    if (budget.left <= 0) break;
    budget.left--;
    newest = Math.max(newest, newestMtimeMs(path.join(p, name), budget));
  }
  return newest;
}

/**
 * 单轮清仓（纯扫描面，无定时器）：`<root>/.helix/tmp` 顶层逐条目判龄，
 * 过龄整删（recursive）。tmp 根不存在（ENOENT——从未落过暂存）返回空结果。
 * 同步执行——tmp 条目量级（几十~几百）下 stat 扫描毫秒级，不值得异步化。
 */
export function sweepWorkspaceTmp(workspaceRoot: string, nowMs: number, opts: SweepOptions = {}): TmpSweepResult {
  const maxAgeMs = opts.maxAgeMs ?? TMP_SWEEP_MAX_AGE_MS;
  const budget = { left: opts.maxScanEntries ?? TMP_SWEEP_MAX_SCAN_ENTRIES };
  const rm = opts.rm ?? ((p: string) => rmSync(p, { recursive: true, force: true }));
  const tmpRoot = resolveWorkspaceTmp(workspaceRoot);
  let entries: string[];
  try {
    entries = readdirSync(tmpRoot);
  } catch {
    return { removed: [], kept: 0, failed: [] }; // 根不存在/不可读：本轮无事可做
  }
  const removed: string[] = [];
  const failed: string[] = [];
  let kept = 0;
  for (const name of entries) {
    const entryPath = path.join(tmpRoot, name);
    const age = nowMs - newestMtimeMs(entryPath, budget);
    if (age < maxAgeMs) {
      kept++;
      continue;
    }
    try {
      rm(entryPath);
      removed.push(name);
    } catch (e) {
      failed.push(name);
      opts.onRemoveError?.(name, e);
    }
  }
  return { removed, kept, failed };
}

/** 定时器句柄（注入面：缺省 setTimeout；测试注入假时钟断言节奏）。 */
export interface SweepScheduleHandle {
  /** 与事件循环解绑（不阻 daemon 退出；注入面可缺省无操作）。 */
  unref?(): void;
  clear(): void;
}

export interface TmpSweeperDeps {
  /** 当前绑定 workspace root（每轮取现值——rebind 天然跟随）；null/undefined = 未绑定跳过本轮。 */
  readonly currentRoot: () => string | null | undefined;
  /** 可观测日志（每轮一行汇总；删除失败 warn）。 */
  readonly logger: Pick<Logger, "info" | "warn">;
  /** 时钟（缺省 Date.now；测试注入）。 */
  readonly now?: () => number;
  /** 定时器（缺省 setTimeout + unref；测试注入）。 */
  readonly schedule?: (fn: () => void, ms: number) => SweepScheduleHandle;
  /** 首轮延迟（缺省 60s——避开启动关键路径）。 */
  readonly firstDelayMs?: number;
  /** 轮间隔（缺省 24h）。 */
  readonly intervalMs?: number;
  /** 过龄阈值（缺省 7d；透传 sweepWorkspaceTmp）。 */
  readonly maxAgeMs?: number;
}

export interface TmpSweeper {
  /** 立即执行一轮（返回结果；未绑定 root 返回空结果）。 */
  sweepNow(): TmpSweepResult;
  /** 停定时器（shutdown 挂点；幂等——停后不再重排）。 */
  stop(): void;
}

/**
 * 启动定时清仓：首轮 firstDelayMs（60s）后执行，此后每 intervalMs（24h）
 * 重排一轮——setTimeout 链而非 setInterval（轮内同步扫描，链式无重入叠跑）。
 * 未绑定 workspace 的轮次空转跳过（unbound boot 零扫描，对齐 W1 语义）。
 */
export function startWorkspaceTmpSweeper(deps: TmpSweeperDeps): TmpSweeper {
  const now = deps.now ?? Date.now;
  const firstDelayMs = deps.firstDelayMs ?? TMP_SWEEP_FIRST_DELAY_MS;
  const intervalMs = deps.intervalMs ?? TMP_SWEEP_INTERVAL_MS;
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number): SweepScheduleHandle => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return { clear: () => clearTimeout(t) };
    });
  let stopped = false;
  let handle: SweepScheduleHandle | undefined;
  const runRound = (): void => {
    const result = sweepNowInternal();
    const root = deps.currentRoot();
    if (root !== null && root !== undefined) {
      const summary =
        result.removed.length === 0 && result.failed.length === 0
          ? `tmp 清仓：无过龄条目（保留 ${result.kept}）`
          : `tmp 清仓：删 ${result.removed.length} 留 ${result.kept} 失败 ${result.failed.length}`;
      deps.logger.info(`${summary} root=${root}`);
    }
    if (!stopped) handle = schedule(runRound, intervalMs); // 链式重排（stop 后不再排）
  };
  const sweepNowInternal = (): TmpSweepResult => {
    const root = deps.currentRoot();
    if (root === null || root === undefined) return { removed: [], kept: 0, failed: [] };
    return sweepWorkspaceTmp(root, now(), {
      ...(deps.maxAgeMs !== undefined ? { maxAgeMs: deps.maxAgeMs } : {}),
      onRemoveError: (name, reason) =>
        deps.logger.warn(`tmp 清仓单条目失败（跳过继续）：${name} ${reason instanceof Error ? reason.message : String(reason)}`),
    });
  };
  handle = schedule(runRound, firstDelayMs);
  return {
    sweepNow: () => sweepNowInternal(),
    stop(): void {
      stopped = true;
      handle?.clear();
      handle = undefined;
    },
  };
}
