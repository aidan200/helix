/**
 * TurnDiffService —— 轮次级内存态 diff 纯操作面（T2 turn diff 数据链）。
 *
 * 【语义】diff 以「轮」为单位累积：轮内首次写某文件前快照原文为基线
 * （首基线永不覆盖——后续写只递增 writeCount/累积 agents），轮结束冻结
 * 结果（unified patch + ±行统计），下一轮清零重来。
 *
 * 【边界——既定决策，勿引入持久化】全内存零落盘：daemon 重启/会话卸载
 * 即丢（SessionRuntime 销毁 = TurnDiffState 销毁——冷态 runtime=undefined
 * 天然无 diff，TR-92 纪律：会话级状态只进 record 字段不开服务级 Map）。
 *
 * 【内存预算】单文件基线 ≤512KB 文本（超限记 hash-only 降级——无原文，
 * ±行按 size 差粗估）；单轮累计 ≤8MB（预算耗尽后新基线一律降级）；
 * 冻结结果环形保留最近 3 轮。
 *
 * 【统计口径】+N=新增行、-N=删除行（无第三统计）；文件级 status:
 * added/deleted/modified/external 保留在数据结构里。
 *
 * 【分层】本文件是 application 纯操作面：IO（读文件/walk/patch 计算）经
 * TurnDiffIoDeps 注入（AG-02② 禁 application import driven——
 * generateUnifiedPatch 的绑定在组合根）。external 兜底（轮首/轮末 stat
 * 索引对比）walk 异步后台做，不阻塞首 token。
 */

/** 单文件轻量 stat（external 兜底索引形态）。 */
export interface FileStatLite {
  readonly mtimeMs: number;
  readonly size: number;
}

/** stat 索引（path 绝对路径 → stat）。 */
export type WorkspaceStatIndexLite = Map<string, FileStatLite>;

/** 文件级状态词汇（数据结构保留四态）。 */
export type TurnDiffFileStatus = "added" | "deleted" | "modified" | "external";

/** 轮内单文件累积条目（active 轮内可变）。 */
export interface TurnDiffFileEntry {
  readonly path: string;
  status: TurnDiffFileStatus;
  /** 轮内首写前原文（基线）；降级（hash-only）/external 条目 = null。 */
  baseline: string | null;
  /** 基线降级：单文件超限或单轮预算耗尽（无原文，仅 hash/size）。 */
  degraded: boolean;
  /** 基线内容指纹（非密码学 FNV-1a / SubAgent 侧 sha256 透传值）。 */
  baselineHash: string;
  /** 基线字节数（external 条目 = 上报 prevSize / walk 索引 size）。 */
  baselineSize: number;
  /** 最新观测字节数（写内容 / external nextSize / walk 终态）。 */
  lastSize: number;
  /** 本轮内写入次数（external 上报不计写次）。 */
  writeCount: number;
  /** 归属 agent 集合（主实例 + SubAgent 实例累积——同文件多 agent）。 */
  readonly agents: Set<string>;
}

/** 冻结后的单文件结果行。 */
export interface FrozenDiffFile {
  readonly path: string;
  readonly status: TurnDiffFileStatus;
  readonly agents: readonly string[];
  readonly added: number;
  readonly removed: number;
  /** unified patch（VENDORED generateUnifiedPatch 产物）；降级/external = null。 */
  readonly patch: string | null;
}

/** 轮级统计（+N=新增行、-N=删除行）。 */
export interface TurnDiffStats {
  readonly added: number;
  readonly removed: number;
}

/** 冻结的一轮 diff 结果（环形保留最近 TURN_DIFF_FROZEN_RING 轮）。 */
export interface FrozenTurnDiff {
  readonly turnId: string;
  readonly outcome: "completed" | "interrupted";
  readonly startedAt: string;
  readonly endedAt: string;
  readonly files: readonly FrozenDiffFile[];
  readonly stats: TurnDiffStats;
}

/** 当前累积中的轮（开轮创建、收轮同步摘下后转冻结流水线）。 */
export interface ActiveTurnDiff {
  readonly turnId: string;
  readonly startedAt: string;
  readonly files: Map<string, TurnDiffFileEntry>;
  /** 基线内存预算累计字节。 */
  baselineBytes: number;
  /** 轮首 stat 索引（external 兜底锚；null = walk 未完成/未装配）。 */
  startIndex: WorkspaceStatIndexLite | null;
  /** 轮首 walk promise（收轮冻结前 await——保证兜底对比确定性；null = 未装配）。 */
  readonly startWalk: Promise<void> | null;
  /** T3 推送：轮内逐写精确增量累计（主进程写路径——captureWrite 携带写后内容即时算；开轮清零）。 */
  liveAdds: number;
  /** T3 推送：同上（删除行维）。 */
  liveDels: number;
}

/** 会话级轮次 diff 状态（挂 SessionRuntime——全内存零持久化）。 */
export interface TurnDiffState {
  /** 当前累积轮（无 open turn 时 null——轮外写不归属）。 */
  active: ActiveTurnDiff | null;
  /** 冻结结果环形（旧→新；超环形容量淘汰最旧）。 */
  frozen: FrozenTurnDiff[];
}

/** IO 注入面（组合根绑定——application 零直接 IO）。 */
export interface TurnDiffIoDeps {
  /** 读 UTF-8 文本（不存在/读失败 → null）；写前快照 + 冻结终读。 */
  readonly readTextFile?: (path: string) => Promise<string | null>;
  /** workspace 递归 stat 索引（external 兜底：轮首/轮末各 walk 一次）。 */
  readonly walkStats?: (root: string) => Promise<WorkspaceStatIndexLite>;
  /** walk 根（缺省/未装配 walkStats → 不做 external 兜底）。 */
  readonly workspaceRoot?: () => string;
  /** unified patch 计算（VENDORED generateUnifiedPatch 绑定；缺省 → 冻结无 patch、朴素估算）。 */
  readonly computePatch?: (path: string, oldContent: string, newContent: string) => string;
  /** 相对路径 → 绝对（写钩子入口归一——与 walk 索引键对齐；缺省恒等）。 */
  readonly absoluteOf?: (path: string) => string;
}

/**
 * 推送回调注入面（T3：照 IO 注入同式的可选注入——服务保持纯操作面零
 * driving import（AG-02②），组合根绑 fan-out publishDelta 瞬态通道）。
 * 回调签名带 state：服务方法零 sessionId 参数（T2 已定），归属会话由
 * 组合根按 state 反查（WeakMap<TurnDiffState, string>）。
 */
export type DiffPushCallback = (state: TurnDiffState, change: DiffChangedPayload) => void;

export interface TurnDiffPushDeps {
  /** 状态变化通知：beginTurn → cleared；recordWrite/recordExternal → active（异步即时重算）；endTurn 冻结 → frozen。 */
  readonly onDiffChanged?: DiffPushCallback;
}

/** 测试探针（onDiffChanged 注入 + 调用记录面）。 */
export interface DiffPushProbe extends TurnDiffPushDeps {
  readonly calls: { state: TurnDiffState; change: DiffChangedPayload }[];
}

/** 轮次 diff 查询视图（diff.get 读面：live 即时 / frozen 冻结）。 */
export interface TurnDiffView {
  readonly turnId: string;
  readonly phase: "active" | "frozen";
  /** frozen 携带（completed/interrupted）；active 缺省。 */
  readonly outcome?: "completed" | "interrupted";
  readonly files: readonly FrozenDiffFile[];
  readonly stats: TurnDiffStats;
}

import type { DiffChangedPayload } from "@helix/protocol";

/** 单文件基线文本上限（超限 hash-only 降级）。 */
export const TURN_DIFF_BASELINE_MAX_BYTES = 512 * 1024;

/** 单轮基线累计预算（耗尽后新基线一律降级）。 */
export const TURN_DIFF_TURN_BUDGET_BYTES = 8 * 1024 * 1024;

/** 冻结结果环形容量（保留最近 3 轮）。 */
export const TURN_DIFF_FROZEN_RING = 3;

/** external/降级条目的 ±行粗估系数（size 差 → 行数；~32B/行启发）。 */
const ESTIMATED_LINE_BYTES = 32;

export function createTurnDiffState(): TurnDiffState {
  return { active: null, frozen: [] };
}

/** 字节数（UTF-8）。 */
function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** 非密码学内容指纹（FNV-1a 32 位 ×2 道——仅 external 对比锚，非安全面）。 */
export function fnvHash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/** 行数（空串 0；结尾无换行的末行计 1）。 */
function countLines(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length;
}

/** size 差 → ±行粗估（external/降级条目口径）。 */
function estimateLineDelta(prevSize: number, nextSize: number): TurnDiffStats {
  const delta = nextSize - prevSize;
  if (delta === 0) return { added: 0, removed: 0 };
  const lines = Math.max(1, Math.round(Math.abs(delta) / ESTIMATED_LINE_BYTES));
  return delta > 0 ? { added: lines, removed: 0 } : { added: 0, removed: lines };
}

/** unified patch → ±行统计（+ 前缀非 +++ = 新增；- 前缀非 --- = 删除）。 */
export function statsFromPatch(patch: string): TurnDiffStats {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue; // 文件头
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/** external 上报元数据（SubAgent file-write 线 / walk 兜底共形）。 */
export interface ExternalWriteMeta {
  readonly path: string;
  readonly prevHash: string;
  readonly prevSize: number;
  readonly nextSize: number;
  /** 归属 agent（SubAgent instanceId；walk 兜底无归属 = 缺省）。 */
  readonly agentId?: string;
}

export class TurnDiffService {
  constructor(
    private readonly io: TurnDiffIoDeps = {},
    private readonly push: TurnDiffPushDeps = {},
  ) {}

  /**
   * 开轮：清零重来（新 active——旧轮文件不带入）+ 后台 stat 索引 walk
   * （不阻塞调用方/首 token；失败静默——external 兜底缺席即降级）。
   */
  beginTurn(state: TurnDiffState, turnId: string, startedAt: string): void {
    const root = this.io.workspaceRoot?.();
    // 轮首后台 walk（不阻塞调用方/首 token；失败静默——external 兜底缺席即降级）
    let startWalk: Promise<void> | null = null;
    if (root !== undefined && this.io.walkStats !== undefined) {
      const walkStats = this.io.walkStats;
      startWalk = walkStats(root)
        .then((index) => {
          if (state.active === active) active.startIndex = index;
        })
        .catch(() => {
          /* walk 失败：external 兜底缺席（降级不报错） */
        });
    }
    const active: ActiveTurnDiff = {
      turnId,
      startedAt,
      files: new Map(),
      baselineBytes: 0,
      startIndex: null,
      startWalk,
      liveAdds: 0,
      liveDels: 0,
    };
    state.active = active;
    // T3 推送：开轮清零信号（同步——前端 chip 清零重计双保险之一）
    this.push.onDiffChanged?.(state, { turnId, phase: "cleared", adds: 0, dels: 0, fileCount: 0 });
  }

  /**
   * env 写钩子入口（组合根绑 mainInstanceId）：读旧内容 + recordWrite。
   * 读失败（IO 异常）→ 按无基线兜底（added 语义），不抛（写链不受影响）。
   * T3：nextContent = 写后内容（wrapEnvForDiff 的 hook 签名自带——T2 绑定
   * 未消费）；携带时同步算逐写精确增量累计并推 active 帧（零读盘零时序
   * 依赖——写前快照与写后统计同点可得）。缺省不推送（T2 形态兼容）。
   */
  async captureWrite(
    state: TurnDiffState,
    path: string,
    agentId: string,
    nextContent?: string | Uint8Array,
  ): Promise<void> {
    const abs = this.io.absoluteOf?.(path) ?? path;
    let prev: string | null = null;
    if (this.io.readTextFile !== undefined) {
      try {
        prev = await this.io.readTextFile(abs);
      } catch {
        prev = null; // 读失败兜底：无基线
      }
    }
    this.recordWrite(state, abs, prev, agentId);
    if (nextContent === undefined) return;
    // T3 推送：逐写精确增量（baseline → 写后内容 patch；与 freezeEntry 同口径）
    const active = state.active;
    if (active === null || this.push.onDiffChanged === undefined) return;
    const delta =
      typeof nextContent === "string"
        ? this.io.computePatch !== undefined
          ? statsFromPatch(this.io.computePatch(abs, prev ?? "", nextContent))
          : estimateLineDelta(byteLength(prev ?? ""), byteLength(nextContent))
        : estimateLineDelta(prev === null ? 0 : byteLength(prev), nextContent.byteLength); // 二进制：size 差粗估
    active.liveAdds += delta.added;
    active.liveDels += delta.removed;
    this.pushActive(state);
  }

  /**
   * 轮内写入记账（纯同步）：首次写快照基线（幂等——首基线永不覆盖），
   * 后续写只递增 writeCount + 累积 agents。轮外写（active=null）静默丢弃。
   */
  recordWrite(state: TurnDiffState, path: string, prevContent: string | null, agentId: string): void {
    const active = state.active;
    if (active === null) return;
    const existing = active.files.get(path);
    if (existing !== undefined) {
      existing.writeCount += 1;
      existing.agents.add(agentId);
      return; // 首基线永不覆盖
    }
    const prevBytes = prevContent === null ? 0 : byteLength(prevContent);
    const overFile = prevContent !== null && prevBytes > TURN_DIFF_BASELINE_MAX_BYTES;
    const overBudget = active.baselineBytes + (overFile ? 0 : prevBytes) > TURN_DIFF_TURN_BUDGET_BYTES;
    const degraded = overFile || overBudget;
    const baseline = prevContent !== null && !degraded ? prevContent : null;
    if (baseline !== null) active.baselineBytes += byteLength(baseline);
    active.files.set(path, {
      path,
      status: prevContent === null ? "added" : "modified",
      baseline,
      degraded,
      baselineHash: fnvHash(prevContent ?? ""),
      baselineSize: prevBytes,
      lastSize: prevBytes,
      writeCount: 1,
      agents: new Set([agentId]),
    });
  }

  /**
   * external 写记账（SubAgent file-write 元数据线 / walk 兜底）：无基线
   * 原文（只报元数据不报内容——stdout 管道安全）；同文件已有条目时只
   * 累积 agents（内容基线不覆盖）。
   */
  recordExternal(state: TurnDiffState, meta: ExternalWriteMeta): void {
    const active = state.active;
    if (active === null) return;
    const existing = active.files.get(meta.path);
    if (existing !== undefined) {
      if (meta.agentId !== undefined) existing.agents.add(meta.agentId);
      existing.lastSize = meta.nextSize;
      return;
    }
    active.files.set(meta.path, {
      path: meta.path,
      status: "external",
      baseline: null,
      degraded: true,
      baselineHash: meta.prevHash,
      baselineSize: meta.prevSize,
      lastSize: meta.nextSize,
      writeCount: 0,
      agents: new Set(meta.agentId !== undefined ? [meta.agentId] : []),
    });
    this.pushActive(state); // T3 推送：external 记账重推累计视图（粗估口径公式自动纳入）
  }

  /**
   * 收轮：同步摘下 active（state.active=null——下一轮 beginTurn 不与冻结
   * 竞态）→ 返回冻结流水线 promise（调用方（ChatService 挂点）fire-and-
   * forget；测试/组合根可 await）。
   */
  endTurn(state: TurnDiffState, outcome: "completed" | "interrupted", endedAt: string): Promise<void> {
    const active = state.active;
    if (active === null) return Promise.resolve();
    state.active = null;
    return this.finalize(active, outcome, endedAt, state);
  }

  /** 冻结流水线：轮首 walk 落定 → 轮末 walk 对比 external 兜底 → 逐条目终读/patch/统计 → 入环形。 */
  private async finalize(
    active: ActiveTurnDiff,
    outcome: "completed" | "interrupted",
    endedAt: string,
    state: TurnDiffState,
  ): Promise<void> {
    await active.startWalk; // 轮首索引确定性（walk 未装配 = null 直过）
    await this.detectExternal(active);
    const files: FrozenDiffFile[] = [];
    let added = 0;
    let removed = 0;
    for (const entry of active.files.values()) {
      const frozen = await this.freezeEntry(entry);
      files.push(frozen);
      // 浮窗批 v3：summary 口径 = 精确层（工具写路径 patch 统计）——external
      // 粗估只进文件列表不进轮 stats（chip 不被 daemon 自产面 size 噪声污染）
      if (frozen.status !== "external") {
        added += frozen.added;
        removed += frozen.removed;
      }
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    state.frozen.push({ turnId: active.turnId, outcome, startedAt: active.startedAt, endedAt, files, stats: { added, removed } });
    while (state.frozen.length > TURN_DIFF_FROZEN_RING) state.frozen.shift();
    // T3 推送：冻结终值（精确统计；turnId 归属轮）
    this.push.onDiffChanged?.(state, {
      turnId: active.turnId,
      phase: "frozen",
      adds: added,
      dels: removed,
      fileCount: files.length,
    });
  }

  /** external 兜底：轮末 walk 与轮首索引对比——变化且无基线的记 external、消失且无条目记 deleted。 */
  private async detectExternal(active: ActiveTurnDiff): Promise<void> {
    const root = this.io.workspaceRoot?.();
    if (root === undefined || this.io.walkStats === undefined || active.startIndex === null) return;
    let endIndex: WorkspaceStatIndexLite;
    try {
      endIndex = await this.io.walkStats(root);
    } catch {
      return; // 轮末 walk 失败：兜底缺席
    }
    for (const [p, end] of endIndex) {
      const start = active.startIndex.get(p);
      if (start !== undefined && start.mtimeMs === end.mtimeMs && start.size === end.size) continue; // 未变
      if (active.files.has(p)) continue; // 已有条目（主进程写/external 上报）——不覆盖
      // 变化且无基线 → external 条目（无 agent 归属；±行按 size 差粗估）
      active.files.set(p, {
        path: p,
        status: "external",
        baseline: null,
        degraded: true,
        baselineHash: "",
        baselineSize: start?.size ?? 0,
        lastSize: end.size,
        writeCount: 0,
        agents: new Set(),
      });
    }
    for (const [p, start] of active.startIndex) {
      if (endIndex.has(p)) continue;
      if (active.files.has(p)) continue; // 写过又删（条目在）——终读缺失统一转 deleted
      // 消失且无条目 → deleted（external 语义：无基线无归属）
      active.files.set(p, {
        path: p,
        status: "deleted",
        baseline: null,
        degraded: true,
        baselineHash: "",
        baselineSize: start.size,
        lastSize: 0,
        writeCount: 0,
        agents: new Set(),
      });
    }
  }

  /** 单条目冻结：内容条目终读 → patch + 精确统计；降级/external → size 差粗估。 */
  private async freezeEntry(entry: TurnDiffFileEntry): Promise<FrozenDiffFile> {
    const agents = [...entry.agents];
    if (entry.status === "external" || entry.status === "deleted") {
      const est = estimateLineDelta(entry.baselineSize, entry.lastSize);
      return { path: entry.path, status: entry.status, agents, added: est.added, removed: est.removed, patch: null };
    }
    // 内容条目（added/modified）：终读当前内容
    const current =
      this.io.readTextFile !== undefined ? await this.safeRead(entry.path) : entry.baseline;
    if (current === null) {
      // 写后同轮又被删（bash rm 等）→ deleted：-基线行数（降级条目粗估）
      const removed =
        entry.baseline !== null
          ? countLines(entry.baseline)
          : estimateLineDelta(entry.baselineSize, 0).removed;
      return { path: entry.path, status: "deleted", agents, added: 0, removed, patch: null };
    }
    // 精确路径：added 条目旧内容恒为空串（无基线也可精确）；modified 需基线原文
    const oldContent = entry.status === "added" ? "" : entry.baseline;
    if (oldContent !== null && this.io.computePatch !== undefined) {
      const patch = this.io.computePatch(entry.path, oldContent, current);
      const stats = statsFromPatch(patch);
      return {
        path: entry.path,
        status: entry.status,
        agents,
        added: stats.added,
        removed: stats.removed,
        patch,
      };
    }
    // 降级条目（hash-only 基线）或无 computePatch：size 差粗估
    const est = estimateLineDelta(entry.baselineSize, byteLength(current));
    return { path: entry.path, status: entry.status, agents, added: est.added, removed: est.removed, patch: null };
  }

  private async safeRead(path: string): Promise<string | null> {
    try {
      return await this.io.readTextFile!(path);
    } catch {
      return null;
    }
  }

  /**
   * T3 推送：轮内累计即时视图（同步零 IO）：liveAdds/liveDels（主进程逐写
   * 精确增量）+ external/降级条目 size 差粗估——收轮 frozen 帧给精确终值。
   */
  private pushActive(state: TurnDiffState): void {
    const cb = this.push.onDiffChanged;
    const active = state.active;
    if (cb === undefined || active === null) return;
    let adds = active.liveAdds;
    let dels = active.liveDels;
    for (const entry of active.files.values()) {
      if (entry.status !== "external") continue;
      const est = estimateLineDelta(entry.baselineSize, entry.lastSize);
      adds += est.added;
      dels += est.removed;
    }
    cb(state, {
      turnId: active.turnId,
      phase: "active",
      adds,
      dels,
      fileCount: active.files.size,
    });
  }

  /**
   * diff.get 读面（T3）：live=true → 进行中轮即时视图（逐条目即时终读统计，
   * 不入冻结环形）；否则 → 冻结轮视图（turnId 缺省 = 最近冻结轮）。
   * v0.3.1 §27：live=true 无进行中轮 → 回落最近冻结轮（rehydrate auto
   * 语义：会话切回单查询即得「进行中或最近轮」）；无 diff（冷态/turnId
   * 未命中）→ null。
   */
  async getTurnView(
    state: TurnDiffState,
    opts: { turnId?: string; live?: boolean } = {},
  ): Promise<TurnDiffView | null> {
    const active = opts.live === true ? state.active : null;
    if (active !== null) {
      const files: FrozenDiffFile[] = [];
      let added = 0;
      let removed = 0;
      for (const entry of active.files.values()) {
        const frozen = await this.freezeEntry(entry);
        files.push(frozen);
        if (frozen.status !== "external") {
          added += frozen.added;
          removed += frozen.removed;
        }
      }
      files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return { turnId: active.turnId, phase: "active", files, stats: { added, removed } };
    }
    const frozenList = state.frozen;
    const hit =
      opts.turnId !== undefined
        ? frozenList.find((f) => f.turnId === opts.turnId)
        : frozenList.length > 0
          ? frozenList[frozenList.length - 1]
          : undefined;
    if (hit === undefined) return null;
    return { turnId: hit.turnId, phase: "frozen", outcome: hit.outcome, files: hit.files, stats: hit.stats };
  }
}
