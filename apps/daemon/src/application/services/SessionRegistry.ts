import type { SessionRepositoryPort, SessionMetadataRow } from "../ports/outbound/SessionRepositoryPort";
import type { ClockPort } from "../ports/outbound/ClockPort";
import type { DomainEvent } from "../../domain/events/DomainEvent";
import { Session } from "../../domain/session/Session";
// MAIN_INSTANCE_ID 引协议导出（v0.2 OI 收口 F-2⑬；与其余 service 同源）
import { MAIN_INSTANCE_ID } from "@helix/protocol";
import type { ToolCallRecordData } from "../../domain/tools/ToolCallRecord";
import type { UsageLedgerData } from "../../domain/session/UsageLedger";
import type { InstanceSnapshotEntry, SessionStateView } from "../ports/inbound/SessionPort";
import type {
  SessionDirectoryPort,
  SessionListChange,
  SessionMetaView,
  SessionRunState,
} from "../ports/inbound/SessionDirectoryPort";
import type { ChatService } from "./ChatService";
import type { SessionProjection } from "./SessionProjection";
import type { SchedulerService } from "./SchedulerService";
import type { RestoredDomainState } from "./RestoreService";

/**
 * SessionRegistry —— 多会话容器（T2.2 AD-4，architecture.md §4）。
 *
 * 【业务语义】daemon 内全部会话运行时的注册表：Map<sessionId, 会话运行时>。
 * - **懒加载**：冷会话（未在注册表）被 get/resolveTarget 触达时从 SQLite
 *   快照重建完整聚合（复用 RestoreService 面：快照 + 事件流重放），重建后
 *   行为与热会话等价；
 * - **空闲卸载**（G-5，默认 30min，ClockPort 计时/测试可缩短）：无活动且
 *   不在执行（主线 idle 且无活跃 SubAgent）的热会话移出注册表——快照已由
 *   write-through 落盘（卸载零丢失）；执行中会话不卸载；
 * - **草稿建会话**（契约 B §1.5 定稿）：首条用户消息建聚合——注册表登记
 *   热运行时（未落库），首事件 write-through 才 INSERT session_state；
 * - **删除收口链**（顺序硬约束）：取消全部执行**完成** → 删库 → 注册表
 *   移除 → list_changed{deleted}。
 *
 * 【接线】组合根工厂化：会话相关件（Session 聚合 + ChatService 族 + 投影
 * 绑定 + 会话绑定引擎/工具）由容器注入的 buildRuntime 工厂按需创建（组合
 * 根外不 new 具体实现，AG 守护）；本服务只管生命周期编排。ChatService:
 * Session 1:1 与 write-through 机制不变（AD-4 取代边界）。
 *
 * 【事件消费】组合根把 fan-out 事件回灌 onDomainEvent（活动标记 + 运行态
 * 变化推 list_changed{state_changed}——去重：与上次广播态比较）；投影路由
 * 由组合根 closure 直连各运行时（projectionRouter）。
 */

/** 会话运行时（会话相关件整体：聚合编排 + 投影；组合根工厂产物）。 */
export interface SessionRuntime {
  readonly sessionId: string;
  readonly chatService: ChatService;
  readonly projection: SessionProjection;
}

/** buildRuntime 工厂入参（恢复产物或新建材料）。 */
export interface RuntimeMaterial {
  readonly session: Session;
  readonly toolCalls: readonly ToolCallRecordData[];
  readonly usage?: UsageLedgerData;
}

export interface SessionRegistryDeps {
  readonly repository: SessionRepositoryPort;
  readonly clock: ClockPort;
  /** 全局调度器（多会话共用；实例归属/取消/恢复注入）。 */
  readonly scheduler: SchedulerService;
  /** 单会话恢复（容器闭包 RestoreService.restore）。 */
  readonly restore: (sessionId: string) => Promise<RestoredDomainState | undefined>;
  /** 会话运行时工厂（组合根：new ChatService/SessionProjection + 会话绑定引擎）。 */
  readonly buildRuntime: (material: RuntimeMaterial) => SessionRuntime;
  /** list_changed 广播出海（容器接 EventStream）。 */
  readonly onListChanged: (change: SessionListChange) => void;
  /** 空闲卸载窗口 ms（G-5：默认 30min；测试经 ClockPort+短窗口验证）。 */
  readonly idleUnloadMs?: number;
  /** 卸载轮询间隔 ms（缺省 min(60s, idleUnloadMs/10)；测试注入小值）。 */
  readonly idlePollMs?: number;
  /** 删除等待主线 run 收口的超时 ms（缺省 5s；超时继续删——活跃被删不崩优先）。 */
  readonly settleTimeoutMs?: number;
  /** 日志（容器接 file logger；缺省静默）。 */
  readonly logger?: { info: (message: string) => void; warn: (message: string) => void };
}

/** 触发 runState 重算（list_changed{state_changed} 判定）的事件集。 */
const RUN_STATE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "agent.state.changed",
  "agent.spawned",
  "agent.queued",
  "agent.started",
  "agent.completed",
  "agent.failed",
  "agent.killed",
]);

/** G-5 默认空闲卸载窗口（30 分钟）。 */
export const DEFAULT_IDLE_UNLOAD_MS = 30 * 60 * 1000;

/** 自动命名长度（契约 B §1.5：首条用户消息截 20 Unicode 码点）。 */
const TITLE_CODEPOINTS = 20;

/** 操作不存在的会话（subscribe / loadHistory / delete；契约 B §3 session.not_found）。 */
export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`会话 ${sessionId} 不存在`);
    this.name = "SessionNotFoundError";
  }
}

/** 同会话删除进行中（重复 delete 请求；契约 B §3 session.delete_in_progress）。 */
export class SessionDeleteInProgressError extends Error {
  constructor(sessionId: string) {
    super(`会话 ${sessionId} 删除进行中（重复请求）`);
    this.name = "SessionDeleteInProgressError";
  }
}

/** 标题推导（`[...msg].slice(0,20).join("")`——中文边界安全）。 */
export function deriveTitle(firstUserText: string | null): string {
  if (firstUserText === null) return "";
  return [...firstUserText].slice(0, TITLE_CODEPOINTS).join("");
}

export class SessionRegistry implements SessionDirectoryPort {
  private readonly runtimes = new Map<string, SessionRuntime>();
  private readonly lastActivityMs = new Map<string, number>();
  /** 上次广播的 runState（state_changed 去重基线）。 */
  private readonly lastBroadcastRunState = new Map<string, SessionRunState>();
  /** 删除进行中的会话（delete_in_progress 判定）。 */
  private readonly deleting = new Set<string>();
  private current: string | undefined;
  private monitor: ReturnType<typeof setInterval> | undefined;
  private readonly idleUnloadMs: number;

  constructor(private readonly deps: SessionRegistryDeps) {
    this.idleUnloadMs = deps.idleUnloadMs ?? DEFAULT_IDLE_UNLOAD_MS;
    const poll = deps.idlePollMs ?? Math.min(60_000, Math.max(1, Math.floor(this.idleUnloadMs / 10)));
    this.monitor = setInterval(() => this.unloadIdle(), poll);
  }

  /** 停卸载监视定时器（daemon shutdown / 测试收尾；幂等）。 */
  stop(): void {
    if (this.monitor !== undefined) {
      clearInterval(this.monitor);
      this.monitor = undefined;
    }
  }

  // ── 启动装配（组合根调用一次） ────────────────────────────

  /**
   * 启动初始化：全部会话元数据可见（不热加载全部聚合——懒加载）；当前会话
   * = 最近活动会话（welcome/CLI 缺省路由目标），显式热加载保证同步读面
   * （SessionService.getSnapshot 兼容路径）。无持久化 → 新建空会话。
   */
  async initialize(): Promise<void> {
    const rows = await this.deps.repository.listSessionMetadata();
    if (rows.length === 0) {
      this.createFresh();
      return;
    }
    const latest = rows[0]!; // updatedAt DESC 首行 = 最近活动
    await this.load(latest.sessionId);
    this.deps.logger?.info(
      `已恢复会话 ${latest.sessionId}（全部会话 ${rows.length} 个元数据可见，懒加载）`,
    );
  }

  // ── SessionDirectoryPort 实现 ─────────────────────────────

  async listSessions(): Promise<readonly SessionMetaView[]> {
    const rows = await this.deps.repository.listSessionMetadata();
    const metas: SessionMetaView[] = rows.map((row) => this.metaFromRow(row));
    for (const [sessionId, runtime] of this.runtimes) {
      if (rows.some((r) => r.sessionId === sessionId)) continue;
      // 热未落库会话（草稿）：DB 无行，从运行时取（title 空串/未命名草稿）
      metas.push(this.metaFromRuntime(runtime));
    }
    metas.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    return metas;
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    if (this.runtimes.has(sessionId)) return true;
    const ids = await this.deps.repository.listSessionIds();
    return ids.includes(sessionId);
  }

  async resolveTarget(sessionId: string | undefined): Promise<string> {
    if (sessionId === undefined || sessionId === null || sessionId === "") {
      return this.currentSessionId();
    }
    if (!this.runtimes.has(sessionId)) {
      await this.load(sessionId); // 懒加载入口（不存在抛 SessionNotFoundError）
    }
    return sessionId;
  }

  async getSessionView(sessionId?: string): Promise<SessionStateView> {
    const target = sessionId ?? this.currentSessionId();
    const runtime = this.runtimes.get(target) ?? (await this.load(target));
    return this.buildView(runtime);
  }

  async startDraftSession(text: string): Promise<{ sessionId: string }> {
    const runtime = this.createFresh();
    // 建会话广播（created）：title = 首条用户消息截断（此刻即知——不等落库）
    this.deps.onListChanged({
      kind: "created",
      sessionId: runtime.sessionId,
      session: this.metaFromRuntime(runtime, deriveTitle(text)),
    });
    // 首条消息发送（fire-and-forget）：首个里程碑事件（user entry）经投影
    // write-through INSERT session_state——「daemon 收首条消息才落库」。
    void runtime.chatService.sendMessage(text).catch((err) => {
      this.deps.logger?.warn(`草稿会话 ${runtime.sessionId} 首条消息发送失败：${(err as Error).message}`);
    });
    return { sessionId: runtime.sessionId };
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (this.deleting.has(sessionId)) throw new SessionDeleteInProgressError(sessionId);
    const hot = this.runtimes.get(sessionId);
    if (hot === undefined && !(await this.sessionExists(sessionId))) {
      throw new SessionNotFoundError(sessionId);
    }
    this.deleting.add(sessionId);
    try {
      if (hot !== undefined) {
        // ① 取消链（顺序硬约束第一步）：主线 abort + 封口（stopped 终态——
        //    closure 注入丢弃/新输入拒收，防删除竞态复活）→ 等 run 收口完成
        hot.chatService.abort();
        hot.chatService.stop();
        await withTimeout(hot.chatService.whenSettled(), this.deps.settleTimeoutMs ?? 5_000);
      }
      // SubAgent 取消（同步收口：queued→cancelled / running→kill 完成）
      this.deps.scheduler.cancelSession(sessionId);
      // ② 删库（单写通道同会话仓 FIFO：①的收口写全部先落盘）
      await this.deps.repository.deleteSession(sessionId);
      // ③ 注册表移除
      this.runtimes.delete(sessionId);
      this.lastActivityMs.delete(sessionId);
      this.lastBroadcastRunState.delete(sessionId);
      if (this.current === sessionId) {
        await this.rotateCurrent();
      }
      // ④ 广播
      this.deps.onListChanged({ kind: "deleted", sessionId });
    } finally {
      this.deleting.delete(sessionId);
    }
  }

  currentSessionId(): string {
    if (this.current === undefined) {
      // initialize 前的防御：daemon 存续期恒有当前会话
      this.createFresh();
    }
    return this.current!;
  }

  // ── 组合根接线面（非 SessionDirectoryPort：内部编排） ──────

  /** 热运行时只读观测（组合根装配 SessionService/ChatRouter；不存在 undefined）。 */
  peek(sessionId: string): SessionRuntime | undefined {
    return this.runtimes.get(sessionId);
  }

  /** 当前会话热运行时（SessionService 同步读面；不存在抛——调用方保证热）。 */
  currentRuntime(): SessionRuntime {
    const rt = this.runtimes.get(this.currentSessionId());
    if (rt === undefined) {
      throw new Error(
        `当前会话 ${this.currentSessionId} 未在注册表（懒加载走 getSessionView/resolveTarget 异步面）`,
      );
    }
    return rt;
  }

  /** 当前会话快照视图（同步读面；冷会话抛错——异步读面走 getSessionView）。 */
  currentView(): SessionStateView {
    return this.buildView(this.currentRuntime());
  }

  /** 懒加载入口（热即返；冷则恢复重建）。 */
  async get(sessionId: string): Promise<SessionRuntime> {
    return this.runtimes.get(sessionId) ?? this.load(sessionId);
  }

  /** fan-out 事件回灌（组合根接线）：活动标记 + runState 变化广播（去重）。 */
  onDomainEvent(event: DomainEvent): void {
    this.touch(event.sessionId);
    if (RUN_STATE_EVENT_TYPES.has(event.type)) {
      this.broadcastRunStateIfChanged(event.sessionId);
    }
  }

  /** 流式 delta 活动标记（不触 runState 重算——中间态不改运行态词汇）。 */
  touchActivity(sessionId: string | undefined): void {
    if (sessionId !== undefined) this.touch(sessionId);
  }

  /** 投影路由（组合根 closure）：事件 → 归属会话运行时的投影消费者。 */
  projectEvent(event: DomainEvent): void {
    this.runtimes.get(event.sessionId)?.projection.publish(event);
  }

  /** 优雅停机：全部热会话封口（stopped 里程碑落盘；空草稿不封——零条目
   *  会话无里程碑可落，「首条消息才落库」哲学下自然消亡，不污染清单）。 */
  sealAll(): void {
    for (const runtime of this.runtimes.values()) {
      if (runtime.chatService.sessionView.entryList().length === 0) continue;
      runtime.chatService.stop();
    }
  }

  // ── 内部 ─────────────────────────────────────────────────

  private touch(sessionId: string): void {
    this.lastActivityMs.set(sessionId, this.deps.clock.nowMs());
    this.current = sessionId; // 当前会话 = 最近活跃
  }

  /** 冷会话恢复重建（快照 + 事件流重放；不存在抛 SessionNotFoundError）。 */
  private async load(sessionId: string): Promise<SessionRuntime> {
    const existing = this.runtimes.get(sessionId);
    if (existing !== undefined) return existing;
    const restored = await this.deps.restore(sessionId);
    if (restored === undefined) throw new SessionNotFoundError(sessionId);
    // 调度器注册表/序号基线注入（幂等：已登记实例跳过重注册——卸载后重载场景）
    this.deps.scheduler.restoreInstances(restored.instances);
    const runtime = this.deps.buildRuntime({
      session: restored.session,
      toolCalls: restored.toolCalls,
      usage: restored.usage,
    });
    this.register(runtime);
    return runtime;
  }

  /** 新建会话（草稿/首启缺省）：热登记、未落库（首事件 write-through 才 INSERT）。 */
  private createFresh(): SessionRuntime {
    const session = Session.create(undefined, this.deps.clock.now());
    const runtime = this.deps.buildRuntime({ session, toolCalls: [], usage: undefined });
    this.register(runtime);
    // T2.1（F5.7/AD-5，契约 v0.4 §2）：主实例 instantiated 发布点 = 会话创建
    //（恢复路径 load() 不调——历史快照经查询面直读；快照缺省供给时 no-op）。
    // 须在 register 之后：fan-out 消费者（CLI 回灌/清单桥）会读
    // currentSessionId()，未登记时触发 createFresh 递归。
    runtime.chatService.publishInstantiated();
    return runtime;
  }

  private register(runtime: SessionRuntime): void {
    this.runtimes.set(runtime.sessionId, runtime);
    this.touch(runtime.sessionId);
    this.lastBroadcastRunState.set(runtime.sessionId, this.runStateOf(runtime.sessionId));
  }

  /** 当前会话被删后的轮换：最近活动会话（懒加载）或新建空会话。 */
  private async rotateCurrent(): Promise<void> {
    const rows = await this.deps.repository.listSessionMetadata();
    if (rows.length === 0) {
      this.createFresh();
      return;
    }
    await this.load(rows[0]!.sessionId);
  }

  /** 空闲卸载（G-5）：无活动且不在执行的热会话移出注册表（快照已落盘）。 */
  private unloadIdle(): void {
    const now = this.deps.clock.nowMs();
    for (const [sessionId, runtime] of this.runtimes) {
      if (this.deleting.has(sessionId)) continue;
      const last = this.lastActivityMs.get(sessionId) ?? now;
      if (now - last < this.idleUnloadMs) continue;
      if (runtime.chatService.agentState !== "idle") continue; // 执行中不卸载（主线）
      if (this.deps.scheduler.hasActiveInstances(sessionId)) continue; // 执行中不卸载（SubAgent）
      this.runtimes.delete(sessionId);
      this.lastActivityMs.delete(sessionId);
      this.deps.logger?.info(`会话 ${sessionId} 空闲超过 ${Math.round(this.idleUnloadMs / 1000)}s，已卸载（快照已落盘，再进懒加载恢复）`);
    }
  }

  /** 会话运行态（协议 SessionMeta.runState 词汇；冷会话 = idle——无执行载体）。 */
  private runStateOf(sessionId: string): SessionRunState {
    const runtime = this.runtimes.get(sessionId);
    if (runtime === undefined) return "idle";
    if (this.deps.scheduler.hasActiveInstances(sessionId)) return "subagent_running";
    return runtime.chatService.agentState === "idle" ? "idle" : "streaming";
  }

  /** state_changed 广播（去重：与上次广播态比较；冷会话无运行时可观测面——跳过）。 */
  private broadcastRunStateIfChanged(sessionId: string): void {
    const next = this.runStateOf(sessionId);
    if (this.lastBroadcastRunState.get(sessionId) === next) return;
    this.lastBroadcastRunState.set(sessionId, next);
    const runtime = this.runtimes.get(sessionId);
    if (runtime === undefined) return;
    this.deps.onListChanged({ kind: "state_changed", sessionId, session: this.metaFromRuntime(runtime) });
  }

  /** 热会话元数据（title 从聚合首条用户消息推导；override 供建会话即知场景）。 */
  private metaFromRuntime(runtime: SessionRuntime, titleOverride?: string): SessionMetaView {
    const entries = runtime.chatService.sessionView.entryList();
    const firstUser = entries.find((e): e is (typeof e) & { role?: string; text?: string } => "role" in e && e.role === "user");
    return {
      sessionId: runtime.sessionId,
      title: titleOverride ?? deriveTitle(firstUser?.text ?? null),
      lastActivityAt: this.lastActivityMs.get(runtime.sessionId) ?? this.deps.clock.nowMs(),
      runState: this.runStateOf(runtime.sessionId),
      loaded: true,
    };
  }

  private metaFromRow(row: SessionMetadataRow): SessionMetaView {
    return {
      sessionId: row.sessionId,
      title: deriveTitle(row.firstUserText),
      lastActivityAt: Date.parse(row.updatedAt),
      runState: this.runStateOf(row.sessionId),
      loaded: this.runtimes.has(row.sessionId),
    };
  }

  /** 快照视图组装（原组合根 SessionService 装配面迁入：实例清单/账目/工具记录合并；组合根/目录口共用）。 */
  buildView(runtime: SessionRuntime): SessionStateView {
    const session = runtime.chatService.sessionView;
    return {
      session: session.toSnapshot(),
      toolCalls: [...runtime.chatService.toolCallData, ...runtime.projection.subAgentToolCallData()],
      // T5.1 热修：per-session 盖章数据源（快照 agentState/model 随视图同源
      // 组装——subscribe/draft 快照不再经 system.getStatus() 全局投影）
      agentState: runtime.chatService.agentState,
      ...(runtime.chatService.currentModel !== undefined
        ? { model: runtime.chatService.currentModel }
        : {}),
      instances: [
        {
          instanceId: MAIN_INSTANCE_ID,
          kind: "main",
          profileKind: "main-session",
          sessionId: runtime.sessionId,
          // T2.1 定稿（architecture-feedback #15）：InstanceState 无常驻待命
          // 词汇——主实例态读 ChatService.agentState（stopped→cancelled，其余
          // running＝存活语义）；会话运行态由快照顶层 agentState 表达
          state: runtime.chatService.agentState === "stopped" ? "cancelled" : "running",
          createdAt: session.createdAt,
          usage: runtime.projection.instanceUsage(MAIN_INSTANCE_ID),
          // T2.3：主实例槽位 = 会话当前模型（引擎可观测面；undefined = 引擎未暴露）
          ...(runtime.chatService.currentModel !== undefined
            ? { model: runtime.chatService.currentModel }
            : {}),
        },
        ...this.deps.scheduler.snapshotInstances(runtime.sessionId).map((instance) => ({
          ...instance,
          usage: runtime.projection.instanceUsage(instance.instanceId),
        })),
      ] satisfies InstanceSnapshotEntry[],
      usage: runtime.projection.usageSummary(),
    };
  }
}

/** 超时包裹（删除收口链的防御上界：活跃被删不崩优先于严格等待）。 */
function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), ms);
    p.finally(() => {
      clearTimeout(timer);
      resolve();
    }).catch(() => resolve());
  });
}
