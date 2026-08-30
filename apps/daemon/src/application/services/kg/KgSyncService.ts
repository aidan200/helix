/**
 * KgSyncService —— sync 管道编排（T2.2，CL-2 F2.1/F2.2，AD-15 定论）。
 *
 * 双源汇队列（自写工具写后通知 + fs-watch 兜底）→ (path,hash) 去重 →
 * 去抖窗口批量 → 单飞（running 标志+合并等待）→ 四步单事务：
 * ① ensure-symbols（CodegraphEnginePort 被动构建；不可用 → degraded 标记
 *   + docs-only 锚：path 声明 × 上一基准文件面物化、symbol 声明跳过）
 * ② 符号+span+contains 导入（增量：mtime/hash 未变跳过；引擎面消失=删除）
 * ③ 锚物化（anchor-materialize 确定性 join，全量重算）
 * ④ 锚失效检测（上一基准活跃锚 − 本次 join → orphan 标记保留行，供 T5.1）
 *   + meta 基准戳推进——全部经 KnowledgeStorePort.applySync 单事务落库。
 *
 * 触发面：生产入口 = 页面手动 triggerManual（含 getStatus/isBuilding
 * 读面）+ fs-watch 监控（B3 重新挂接，推翻 2026-08-29 退役裁决：索引
 * 建成后 KgFsWatchService per-project watcher → onFsEvent 归一入口）；
 * 启动 onStartup 全量触发 / edit 工具写后 notifyWrite 注入按 2026-08-29
 * 用户裁决维持退役（方法与其行为单测保留，能力面不动）。多项目按
 * projectRoot 隔离（per-project 队列与状态）。
 *
 * 附着不依赖新鲜度（AD-15）：本服务不暴露任何「等 sync」接口；附着读
 * 快照走 KnowledgeGraphPort 直读（滞后合法），本文件零读附着面。
 */

import type { CodegraphEnginePort } from "../../ports/outbound/CodegraphEnginePort";
import type { KnowledgeGraphPort } from "../../ports/outbound/KnowledgeGraphPort";
import type { KnowledgeStorePort } from "../../ports/outbound/KnowledgeStorePort";
import { relative } from "node:path";
import { anchorKey, materializeAnchors } from "../../../domain/kg/anchor-materialize";
import type {
  EngineSymbol,
  IndexStatus,
  MaterializedAnchor,
  SymbolBatch,
  SymbolContainsEdge,
  SymbolFileRecord,
  SymbolRecord,
  SymbolSet,
  SyncBaselineView,
} from "../../../domain/kg/types";

/** 去抖窗口（brief 决策消解：2-5s 取 3s；测试注入短窗）。 */
export const DEBOUNCE_MS = 3000;

/** 连续失败自动重试上限（F-21 结构参数：MAX_SYNC_FAILURE_RETRIES）。 */
export const MAX_SYNC_FAILURE_RETRIES = 5;

/** 退避上限（F-21 结构参数：30s；锁竞争由 KgDatabase busy_timeout 吸收，残余进本通道）。 */
export const RETRY_BACKOFF_MAX_MS = 30000;

export interface KgSyncServiceDeps {
  readonly store: KnowledgeStorePort;
  readonly graph: KnowledgeGraphPort;
  readonly engine: CodegraphEnginePort;
  /** 去抖窗口 ms（缺省 DEBOUNCE_MS）。 */
  readonly debounceMs?: number;
  /** 失败退避基数 ms（指数退避，缺省 1000，上限 RETRY_BACKOFF_MAX_MS）。 */
  readonly retryBackoffMs?: number;
  /**
   * sync 成功钩子（B3 fs-watch 挂接缝：索引建成 absent→building→synced 后
   * 组合根接到 KgFsWatchService.watchProject 启动 per-project watcher；
   * 每次 sync 成功都调，watchProject 幂等吸收重复挂接）。
   */
  readonly onSynced?: (projectRoot: string) => void;
}

/** fs-watch 事件归一形态（兑底信号面；生产挂接已退役，方法保留）。 */
export type FsEventKind = "write" | "remove";

/** 一次 sync 的结果（triggerManual/onStartup 返回；orphanedAnchors=失效信号供 T5.1 入队）。 */
export interface SyncResult {
  readonly projectRoot: string;
  readonly baseline: string;
  readonly degraded: boolean;
  readonly importedFiles: number;
  readonly deletedFiles: number;
  readonly orphanedAnchors: readonly MaterializedAnchor[];
  readonly syncedAt: string;
}

/** 索引状态四态（§3.5；T5.3 kg.index.status 契约的 service 面数据源）。 */
export type KgIndexPhase = "absent" | "building" | "synced" | "degraded";

export interface KgIndexStatus {
  readonly phase: KgIndexPhase;
  readonly baseline: string | null;
  readonly symbolCount: number;
  readonly degraded: boolean;
  readonly syncedAt: string | null;
}

/** per-project 运行态（队列/去抖/单飞按项目根隔离，AD-15）。 */
interface ProjectRunState {
  readonly queue: Map<string, string | null>; // relPath → 最新 hash（watch 事件无 hash=null）
  readonly deleted: Set<string>; // relPath（remove 事件）
  debounceTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  pendingRerun: boolean;
  failCount: number;
  currentRun: Promise<SyncResult> | null;
  baselineCounter: number;
  baselineLoaded: boolean;
  lastSyncedAt: string | null;
}

/** EngineUnavailable 鸭子判别（TR-AD-1：application 不 import adapters）。 */
function isEngineUnavailable(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { kind?: unknown }).kind === "EngineUnavailable";
}

const yieldTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export class KgSyncService {
  private readonly deps: KgSyncServiceDeps;
  private readonly debounceMs: number;
  private readonly retryBackoffMs: number;
  private readonly states = new Map<string, ProjectRunState>();

  constructor(deps: KgSyncServiceDeps) {
    this.deps = deps;
    this.debounceMs = deps.debounceMs ?? DEBOUNCE_MS;
    this.retryBackoffMs = deps.retryBackoffMs ?? 1000;
  }

  // ── 触发面 ────────────────────────────────────────────────

  /** 写后通知（自写 edit 工具落盘后投递；微秒级入队，不在写路径跑 sync）。 */
  notifyWrite(projectRoot: string, path: string, hash: string): void {
    const state = this.stateOf(projectRoot);
    const rel = relPathOf(projectRoot, path);
    state.deleted.delete(rel);
    state.queue.set(rel, hash);
    this.scheduleDebounce(projectRoot, state);
  }

  /** fs-watch 兜底事件（外部编辑/删/改名；write=存在类变更，remove=消失）。 */
  onFsEvent(projectRoot: string, path: string, kind: FsEventKind): void {
    const state = this.stateOf(projectRoot);
    const rel = relPathOf(projectRoot, path);
    if (kind === "remove") {
      state.queue.delete(rel);
      state.deleted.add(rel);
    } else {
      state.deleted.delete(rel);
      state.queue.set(rel, null); // watch 事件无 hash；sync 侧以引擎面为准
    }
    this.scheduleDebounce(projectRoot, state);
  }

  /** 页面手动触发（T5.3 kg.index.status rebuild 消费面）：立即完整 sync。 */
  triggerManual(projectRoot: string): Promise<SyncResult> {
    const state = this.stateOf(projectRoot);
    this.cancelTimers(state); // 吸收去抖窗口/退避 timer（syncOnce drain 兜住队列）
    return this.awaitTurnAndRun(projectRoot, state);
  }

  /** daemon 启动触发（异步不阻塞启动；冷启动首建=知识层空合法）。 */
  onStartup(projectRoot: string): Promise<SyncResult> {
    return this.triggerManual(projectRoot);
  }

  /** 构建中判定（纯内存读面——indexStatus 的 absent 短路前置用，不触库保 A8）。 */
  isBuilding(projectRoot: string): boolean {
    return this.states.get(projectRoot)?.running === true;
  }

  /** 索引状态四态 + 基准戳/符号数（T5.3 service 面数据；读库不排队）。 */
  getStatus(projectRoot: string): KgIndexStatus {
    const state = this.states.get(projectRoot);
    const idx: IndexStatus = this.deps.graph.getIndexStatus(projectRoot);
    let phase: KgIndexPhase;
    if (state?.running === true) phase = "building";
    else if (idx.baseline === null) phase = "absent";
    else if (idx.degraded) phase = "degraded";
    else phase = "synced";
    return {
      phase,
      baseline: idx.baseline,
      symbolCount: idx.symbolCount,
      degraded: idx.degraded,
      syncedAt: state?.lastSyncedAt ?? null,
    };
  }

  /** 清理 per-project 计时器（测试清理/daemon 退出；库内容不受影响）。 */
  dispose(projectRoot?: string): void {
    const targets = projectRoot === undefined ? [...this.states.keys()] : [projectRoot];
    for (const root of targets) {
      const state = this.states.get(root);
      if (state === undefined) continue;
      this.cancelTimers(state);
      this.states.delete(root);
    }
  }

  // ── 单飞状态机（running 标志 + 合并等待，AD-15） ──────────

  private scheduleDebounce(projectRoot: string, state: ProjectRunState): void {
    if (state.debounceTimer !== null) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      this.scheduleRun(projectRoot, state);
    }, this.debounceMs);
  }

  private scheduleRun(projectRoot: string, state: ProjectRunState): void {
    if (state.running) {
      state.pendingRerun = true; // 合并等待：当前事务完成后自动重跑，不丢弃
      return;
    }
    this.runSync(projectRoot, state, false).catch(() => {
      // 失败已计数并排退避重试（runNow 内）；此处吞声防 unhandledRejection
    });
  }

  /**
   * 手动/启动的「轮到我就跑」循环：running 中纯等待当前事务（不置
   * pendingRerun——那是事件流合并等待通道，叠加会产无限重跑链）；
   * 醒来 idle 则自己跑完整域。
   */
  private async awaitTurnAndRun(projectRoot: string, state: ProjectRunState): Promise<SyncResult> {
    for (;;) {
      if (!state.running) return await this.runSync(projectRoot, state, true);
      const current = state.currentRun;
      if (current !== null) await current.catch(() => {});
      else await yieldTick(); // finally 间隙防御：让出再复查
    }
  }

  private runSync(projectRoot: string, state: ProjectRunState, full: boolean): Promise<SyncResult> {
    const run = this.runNow(projectRoot, state, full);
    state.currentRun = run;
    return run;
  }

  private async runNow(projectRoot: string, state: ProjectRunState, full: boolean): Promise<SyncResult> {
    state.running = true;
    try {
      const result = await this.syncOnce(projectRoot, state, full);
      state.failCount = 0;
      state.lastSyncedAt = result.syncedAt;
      this.deps.onSynced?.(projectRoot); // B3：索引建成/刷新 → watcher 挂接点
      return result;
    } catch (error) {
      state.failCount += 1;
      if (state.failCount <= MAX_SYNC_FAILURE_RETRIES) {
        const backoff = Math.min(this.retryBackoffMs * 2 ** (state.failCount - 1), RETRY_BACKOFF_MAX_MS);
        state.retryTimer = setTimeout(() => {
          state.retryTimer = null;
          this.scheduleRun(projectRoot, state);
        }, backoff);
      }
      throw error;
    } finally {
      state.running = false;
      state.currentRun = null;
      if (state.pendingRerun) {
        state.pendingRerun = false;
        // 事件流合并重跑：窗口域（失败回填保真）；失败自行退避
        this.runSync(projectRoot, state, false).catch(() => {});
      }
    }
  }

  // ── 四步管道（单事务经 applySync） ─────────────────────────

  /**
   * 一次完整 sync：drain 窗口（失败回填不丢事件）→ ensure/export（degraded
   * 捕获）→ 增量域计算（导入/删除）→ 引擎投影 → 物化 join（全量重算）→
   * orphan 差集 → applySync 单事务。
   */
  private async syncOnce(projectRoot: string, state: ProjectRunState, full: boolean): Promise<SyncResult> {
    const windowKinds = this.drainWindow(state);
    const baselineView: SyncBaselineView = this.deps.graph.getSyncBaseline(projectRoot);

    let degraded = false;
    let symbolSet: SymbolSet = { symbols: [], containsEdges: [], files: [] };
    try {
      await this.deps.engine.ensureIndex(projectRoot);
      symbolSet = await this.deps.engine.exportSymbols(projectRoot);
    } catch (e) {
      if (!isEngineUnavailable(e)) throw e;
      degraded = true;
    }

    const engineFiles = new Map(symbolSet.files.map((f) => [f.path, f]));
    const prevFiles = new Map(baselineView.files.map((f) => [f.path, f]));
    const filePaths: readonly string[] = degraded
      ? baselineView.files.map((f) => f.path) // docs-only：上一基准文件面（滞后合法）
      : [...engineFiles.keys()];

    const importFiles: SymbolFileRecord[] = [];
    const deletedFiles: string[] = [];
    const seen = new Set<string>();
    if (!degraded) {
      // 域：full=引擎面全量∪窗口（手动/启动/首建）；窗口路径=只处理窗口内变更文件
      const domainPaths: readonly string[] = full ? [...filePaths, ...windowKinds.keys()] : [...windowKinds.keys()];
      for (const p of domainPaths) {
        if (seen.has(p)) continue;
        seen.add(p);
        const engineFile = engineFiles.get(p);
        if (engineFile === undefined) {
          // 引擎面无此文件：窗口 remove/改名/非源文件 → 上一基准有则整文件清除
          if (prevFiles.has(p)) deletedFiles.push(p);
          continue;
        }
        const prev = prevFiles.get(p);
        if (prev !== undefined && prev.mtime === engineFile.modifiedAt && prev.sha256 === engineFile.contentHash) {
          continue; // mtime/hash 未变跳过（增量基准）
        }
        importFiles.push({ path: p, mtime: engineFile.modifiedAt, sha256: engineFile.contentHash });
      }
    }

    const symbolFace = degraded ? [] : symbolSet.symbols.filter((s) => !s.id.startsWith("file:"));
    const importDomain = new Set(importFiles.map((f) => f.path));
    const symbols: SymbolRecord[] = symbolFace
      .filter((s) => importDomain.has(s.filePath))
      .map((s) => ({ name: s.name, kind: s.kind, spanStart: s.startLine, spanEnd: s.endLine, file: s.filePath }));
    const containsEdges = degraded ? [] : projectContains(symbolSet, importDomain);

    // 锚物化（确定性 join 全量重算；degraded docs-only：symbol 面空 → symbol 声明零锚）
    const materializedAnchors = materializeAnchors({
      declarations: baselineView.anchorDeclarations,
      filePaths,
      symbols: symbolFace.map((s) => ({ name: s.name, file: s.filePath })),
    });
    // 锚失效检测：上一基准活跃锚 − 本次 join（符号消亡/声明撤销 → orphan）
    const orphanedAnchors: MaterializedAnchor[] = degraded
      ? [] // degraded 不做 diff：symbol 锚保持旧态滞后合法（恢复后下次 sync 重算）
      : baselineView.activeAnchors.filter((a) => !new Set(materializedAnchors.map(anchorKey)).has(anchorKey(a)));

    const baseline = this.nextBaseline(projectRoot, state);
    const syncedAt = new Date().toISOString();
    const batch: SymbolBatch = {
      files: importFiles,
      symbols,
      containsEdges,
      materializedAnchors,
      deletedFiles,
      orphanedAnchors,
      baseline,
      degraded,
    };
    try {
      await this.deps.store.applySync(projectRoot, batch);
    } catch (error) {
      // 失败回填：本批域回窗口（write=引擎面在册/remove=删除），重试域保真不丢事件
      for (const f of importFiles) windowKinds.set(f.path, "write");
      for (const p of deletedFiles) windowKinds.set(p, "remove");
      this.refillWindow(state, windowKinds);
      throw error;
    }
    return {
      projectRoot,
      baseline,
      degraded,
      importedFiles: importFiles.length,
      deletedFiles: deletedFiles.length,
      orphanedAnchors,
      syncedAt,
    };
  }

  // ── 队列/窗口/基准戳 ──────────────────────────────────────

  private drainWindow(state: ProjectRunState): Map<string, FsEventKind> {
    const window = new Map<string, FsEventKind>();
    for (const [path, hash] of state.queue) {
      window.set(path, "write");
      if (hash === null) state.deleted.delete(path); // 防御：write 后到覆盖 remove
    }
    for (const path of state.deleted) window.set(path, "remove");
    state.queue.clear();
    state.deleted.clear();
    return window;
  }

  private refillWindow(state: ProjectRunState, window: ReadonlyMap<string, FsEventKind>): void {
    for (const [path, kind] of window) {
      if (kind === "remove") state.deleted.add(path);
      else state.queue.set(path, null);
    }
  }

  /** meta 基准戳单调推进（per-project 内存计数；首用从库内现值续号）。 */
  private nextBaseline(projectRoot: string, state: ProjectRunState): string {
    if (!state.baselineLoaded) {
      const current = this.deps.graph.getIndexStatus(projectRoot).baseline;
      state.baselineCounter = Number(current ?? 0) || 0;
      state.baselineLoaded = true;
    }
    state.baselineCounter += 1;
    return String(state.baselineCounter);
  }

  private stateOf(projectRoot: string): ProjectRunState {
    const cached = this.states.get(projectRoot);
    if (cached !== undefined) return cached;
    const state: ProjectRunState = {
      queue: new Map(),
      deleted: new Set(),
      debounceTimer: null,
      retryTimer: null,
      running: false,
      pendingRerun: false,
      failCount: 0,
      currentRun: null,
      baselineCounter: 0,
      baselineLoaded: false,
      lastSyncedAt: null,
    };
    this.states.set(projectRoot, state);
    return state;
  }

  private cancelTimers(state: ProjectRunState): void {
    if (state.debounceTimer !== null) {
      clearTimeout(state.debounceTimer);
      state.debounceTimer = null;
    }
    if (state.retryTimer !== null) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
  }
}

// ── 纯投影 helper ──────────────────────────────────────────

/** 引擎 contains 边 → 导入域内 (file, outer, inner)：文件容器 outer=路径；跨文件/悬挂边丢弃。 */
function projectContains(symbolSet: SymbolSet, importDomain: ReadonlySet<string>): SymbolContainsEdge[] {
  const byId = new Map<string, EngineSymbol>(symbolSet.symbols.map((s) => [s.id, s] as const));
  const out: SymbolContainsEdge[] = [];
  for (const edge of symbolSet.containsEdges) {
    const inner = byId.get(edge.symbolId);
    if (inner === undefined || !importDomain.has(inner.filePath)) continue;
    const outer = byId.get(edge.containerId);
    let outerSymbol: string;
    if (outer !== undefined) {
      if (outer.filePath !== inner.filePath) continue; // contains 表按 file 键
      outerSymbol = outer.name;
    } else if (edge.containerId.startsWith("file:")) {
      outerSymbol = edge.containerId.slice("file:".length);
    } else {
      continue; // 悬挂边防御
    }
    out.push({ file: inner.filePath, outerSymbol, innerSymbol: inner.name });
  }
  return out;
}

/** 事件路径归一：绝对路径 → 相对 projectRoot（引擎面相对语义同源）。 */
function relPathOf(projectRoot: string, path: string): string {
  if (!path.startsWith("/")) return path;
  return relative(projectRoot, path) || path;
}
