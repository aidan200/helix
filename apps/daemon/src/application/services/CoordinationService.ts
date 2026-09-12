/**
 * CoordinationService —— 占用协调服务（U4，daemon 全局内存单例）。
 *
 * 为什么存在：跨会话共享工作树的写冲突（TR-63 实证）需要一个机械可见的
 * 「谁在占用哪个范围」事实面。租约模型三层语义：
 * - 感知（undeclared 检出）：写事实登记表逐事实回调——无租约覆盖的
 *   ≥inferred 写自动补登租约（漏声明从踩踏隐患变为可见偏差）；
 * - 声明（claim/release）：决策主体显式声明意图——claim 永不拒绝，
 *   重叠返回冲突详情 + 裁决辅助序（系统不裁决：判不了「改没改完」
 *   就没有资格拒绝）；
 * - 对账（轮末机械降级）：turn.completed 时 daemon 自己读 plan 台账——
 *   全 resolve 且本轮无新写 → settled（零 LLM 参与、零注入、零催办；
 *   机械降级消解九成场景，剩余偏差只沉淀审计事件行）。
 *
 * 生命周期四销毁口：release 意图 / 窗口消亡（subagent 终态 + 会话卸载）/
 * settled TTL 过期物理删 / daemon 重启全表清零（liveness 态不持久化不
 * 重放——重启本就打断全部执行，重新声明是零成本操作）。
 *
 * shared spawn 不登记租约（设计偏差裁决）：事实型 undeclared 检出按项目
 * 粒度覆盖写冲突可见性（信号更准、噪声更低——workspace 级粗租约会让
 * 任意两并行 spawn 互相报冲突）；isolated spawn 经 registerWorktree 登记
 * worktree 范围租约（不构成主树冲突面，纯「分支在飞」元信息）。
 *
 * 纯内存操作面（AG-02：application 零 IO）；plan 读面经晚绑注入。
 */

import type { DomainEvent, CoordLeasePayload } from "../../domain/events/DomainEvent";
import type { WriteFact } from "../../domain/writefact/types";
import {
  type LeaseScope,
  type LeaseSource,
  type LeaseStatus,
  type OccupancyLeaseData,
  describeScope,
  isBlocking,
  normalizeScopePath,
  scopeCoversPath,
  scopesOverlap,
} from "../../domain/agent/OccupancyLease";
import { projectRootOfAbs } from "../../domain/kg/project-discovery";
import type { PlanResolution } from "./task/WorkLedgerService";
import type { WriteFactRegistry } from "./WriteFactRegistry";

export interface CoordinationDeps {
  /** 审计事件发布口（fanout 引用——event-row-persistence 落 domain_events）。 */
  readonly publish: (event: DomainEvent) => void;
  /** 写事实登记表（undeclared 检出输入 + 轮末对账「无新写」判据）。 */
  readonly writeFacts: WriteFactRegistry;
  /** 主会话 plan 读面（晚绑：mainPlan 服务在栈内后段构造）。 */
  readonly planReaderFor: () => { isFullyResolved(instanceId: string): PlanResolution } | undefined;
  /** workspace 根（undeclared 租约的项目范围归约）。 */
  readonly workspaceRoot: () => string | undefined;
  /** 时钟注入（测试确定性）。 */
  readonly now: () => number;
  /** settled 保留窗口（缺省 1h——「谁刚用过」可查期后物理删）。 */
  readonly settleTtlMs?: number;
  /** ghost 降级阈值（缺省 6h——超长闲置不算阻塞面）。 */
  readonly ghostAfterMs?: number;
}

export interface ClaimInput {
  readonly ownerSessionId: string;
  readonly ownerAgentId: string;
  readonly scope: LeaseScope;
  readonly intent: string;
  readonly source?: LeaseSource;
  readonly executors?: readonly string[];
}

export interface ClaimResult {
  readonly lease: OccupancyLeaseData;
  /** 与其他会话阻塞租约的重叠清单（claim 永不拒绝——裁决辅助信息）。 */
  readonly conflicts: readonly OccupancyLeaseData[];
  /** 幂等重入：同会话同范围已有生效租约时返回既有（不重复发事件）。 */
  readonly deduplicated: boolean;
}

interface LeaseState {
  data: OccupancyLeaseData;
}

const SETTLE_TTL_MS_DEFAULT = 60 * 60 * 1000;
const GHOST_AFTER_MS_DEFAULT = 6 * 60 * 60 * 1000;

let leaseSeq = 0;
function newLeaseId(): string {
  leaseSeq += 1;
  return `lease-${Date.now().toString(36)}-${leaseSeq.toString(36)}`;
}

export class CoordinationService {
  private readonly byId = new Map<string, LeaseState>();
  private readonly turnStartAt = new Map<string, number>();
  private readonly settleTtlMs: number;
  private readonly ghostAfterMs: number;

  constructor(private readonly deps: CoordinationDeps) {
    this.settleTtlMs = deps.settleTtlMs ?? SETTLE_TTL_MS_DEFAULT;
    this.ghostAfterMs = deps.ghostAfterMs ?? GHOST_AFTER_MS_DEFAULT;
  }

  // ── 声明面（coord 工具消费；ownerAgentId 由装配面注入防伪造） ──

  claim(input: ClaimInput): ClaimResult {
    this.sweep();
    const now = this.deps.now();
    // 幂等重入：同会话 + 同范围描述 + 阻塞态租约 → 刷新活跃时刻返回既有
    const desc = describeScope(input.scope);
    for (const st of this.byId.values()) {
      if (
        st.data.ownerSessionId === input.ownerSessionId &&
        isBlocking(st.data.status) &&
        describeScope(st.data.scope) === desc
      ) {
        // 显式认领升级：undeclared/isolated 租约被 owner claim → source 转 claimed（声明补全，审计闭环）
        const upgraded = st.data.source !== "claimed";
        st.data = {
          ...st.data,
          lastActivityAt: Math.max(st.data.lastActivityAt, now),
          intent: input.intent,
          ...(upgraded ? { source: "claimed" as const } : {}),
        };
        if (upgraded) {
          const conflicts = this.conflictsFor(input.scope, input.ownerSessionId);
          this.emit("coord.claimed", st.data, conflicts.length > 0 ? conflicts.map((c) => c.leaseId) : undefined);
        }
        return { lease: st.data, conflicts: this.conflictsFor(input.scope, input.ownerSessionId), deduplicated: true };
      }
    }
    const lease: OccupancyLeaseData = {
      leaseId: newLeaseId(),
      ownerSessionId: input.ownerSessionId,
      ownerAgentId: input.ownerAgentId,
      executors: input.executors ?? [],
      scope: input.scope,
      intent: input.intent,
      source: input.source ?? "claimed",
      status: "active",
      claimedAt: now,
      lastActivityAt: now,
    };
    this.byId.set(lease.leaseId, { data: lease });
    const conflicts = this.conflictsFor(input.scope, input.ownerSessionId);
    this.emit("coord.claimed", lease, conflicts.length > 0 ? conflicts.map((c) => c.leaseId) : undefined);
    return { lease, conflicts, deduplicated: false };
  }

  /** 释放本会话租约（scope 缺省 = 全部；返回释放数）。 */
  release(input: { ownerSessionId: string; scope?: LeaseScope }): { released: number } {
    let released = 0;
    for (const [id, st] of [...this.byId]) {
      if (st.data.ownerSessionId !== input.ownerSessionId) continue;
      if (input.scope !== undefined && !scopesOverlap(input.scope, st.data.scope)) continue;
      this.byId.delete(id);
      released += 1;
      this.emit("coord.released", st.data);
    }
    return { released };
  }

  // ── 读面（coord_query / 观测） ──

  leases(filter?: { sessionId?: string; includeSettled?: boolean }): readonly OccupancyLeaseData[] {
    this.sweep();
    const out: OccupancyLeaseData[] = [];
    for (const st of this.byId.values()) {
      if (filter?.sessionId !== undefined && st.data.ownerSessionId !== filter.sessionId) continue;
      if (filter?.includeSettled !== true && !isBlocking(st.data.status) && st.data.status !== "ghost") continue;
      out.push(st.data);
    }
    return out;
  }

  /** 与范围重叠的其他会话阻塞租约（claim 冲突面）。 */
  conflictsFor(scope: LeaseScope, excludeSessionId?: string): readonly OccupancyLeaseData[] {
    this.sweep();
    const out: OccupancyLeaseData[] = [];
    for (const st of this.byId.values()) {
      if (!isBlocking(st.data.status)) continue;
      if (excludeSessionId !== undefined && st.data.ownerSessionId === excludeSessionId) continue;
      if (scopesOverlap(scope, st.data.scope)) out.push(st.data);
    }
    return out;
  }

  // ── 机械面（装配回调 + fanout named target） ──

  /**
   * 写事实回调（WriteFactRegistry factObserver）：覆盖检查 + undeclared
   * 自动补登 + 活跃刷新。uncertain/unknown 不触发（噪声面）。
   */
  onWriteFact(fact: WriteFact): void {
    if (fact.confidence !== "precise" && fact.confidence !== "inferred") return;
    // 本会话已有阻塞租约覆盖该路径 → 刷新活跃时刻（不新建）
    for (const st of this.byId.values()) {
      if (
        st.data.ownerSessionId === fact.sessionId &&
        isBlocking(st.data.status) &&
        scopeCoversPath(st.data.scope, fact.path)
      ) {
        st.data = { ...st.data, lastActivityAt: Math.max(st.data.lastActivityAt, fact.at) };
        return;
      }
    }
    // undeclared 补登：项目根范围（归约失败 → 路径所在目录前缀）；同会话
    // 同范围已有 undeclared 租约 → 刷新（去噪）
    const scope = this.scopeOfPath(fact.path);
    if (scope === undefined) return;
    const desc = describeScope(scope);
    for (const st of this.byId.values()) {
      if (
        st.data.ownerSessionId === fact.sessionId &&
        st.data.source === "undeclared" &&
        isBlocking(st.data.status) &&
        describeScope(st.data.scope) === desc
      ) {
        st.data = {
          ...st.data,
          lastActivityAt: Math.max(st.data.lastActivityAt, fact.at),
          executors: st.data.executors.includes(fact.instanceId)
            ? st.data.executors
            : [...st.data.executors, fact.instanceId],
        };
        return;
      }
    }
    const lease: OccupancyLeaseData = {
      leaseId: newLeaseId(),
      ownerSessionId: fact.sessionId,
      ownerAgentId: fact.instanceId,
      executors: [fact.instanceId],
      scope,
      intent: "未声明的写行为（自动补登）",
      source: "undeclared",
      status: "active",
      claimedAt: fact.at,
      lastActivityAt: fact.at,
    };
    this.byId.set(lease.leaseId, { data: lease });
    this.emit("coord.undeclared", lease);
  }

  /** isolated spawn 的 worktree 登记（SchedulerService.registerWorktree 链）。 */
  onWorktree(input: { sessionId: string; executorId: string; worktreeRoot: string }): void {
    this.claim({
      ownerSessionId: input.sessionId,
      ownerAgentId: input.executorId,
      scope: { kind: "paths", patterns: [normalizeScopePath(input.worktreeRoot)] },
      intent: "isolated worktree（分支在飞）",
      source: "isolated",
      executors: [input.executorId],
    });
  }

  /** subagent 终态（收口链注入）：摘执行者；isolated 租约执行者清空即释放。 */
  onSubagentSettled(executorId: string): void {
    for (const [id, st] of [...this.byId]) {
      if (!st.data.executors.includes(executorId)) continue;
      const executors = st.data.executors.filter((e) => e !== executorId);
      if (executors.length === 0 && st.data.source === "isolated") {
        this.byId.delete(id);
        this.emit("coord.released", st.data);
      } else {
        st.data = { ...st.data, executors };
      }
    }
  }

  /** 会话卸载（SessionRegistry onSessionUnload 链）：该会话租约全释放。 */
  onSessionGone(sessionId: string): void {
    this.release({ ownerSessionId: sessionId });
  }

  /**
   * fanout named target 入口（coord-bridge）：只消费轮边界与实例状态族；
   * coord.* 自身事件忽略（防回环）。main 会话 turn.* 达 fanout（SubAgent
   * translator 不上 turn 族——事实核实，免「main 会话」判定过滤）。
   */
  onDomainEvent(event: DomainEvent): void {
    switch (event.type) {
      case "turn.started":
        this.turnStartAt.set(event.sessionId, Date.parse(event.occurredAt));
        return;
      case "turn.completed":
        this.reconcileAtTurnEnd(event.sessionId);
        return;
      case "agent.stalled": {
        // stalled payload 有 agentId；缺 instanceId 字段时按 envelope 归属
        const executor = (event.payload as { agentId?: string } | undefined)?.agentId ?? event.instanceId;
        if (executor === undefined) return;
        for (const st of this.byId.values()) {
          if (st.data.executors.includes(executor) && st.data.status === "active") {
            st.data = { ...st.data, status: "stale" };
          }
        }
        return;
      }
      case "agent.completed":
      case "agent.failed":
      case "agent.killed": {
        const executor = (event.payload as { agentId?: string } | undefined)?.agentId ?? event.instanceId;
        if (executor !== undefined) this.onSubagentSettled(executor);
        return;
      }
      default:
        return;
    }
  }

  // ── 内部 ─────────────────────────────────────────────

  /**
   * 轮末机械对账（零 LLM 参与）：plan 全 resolve 且本轮无新写 → settled。
   * plan 读面未注入（测试形态）/无租约 → no-op；台账未结或本轮有写 →
   * 保持 active（系统只记事实，不催办不注入）。
   */
  private reconcileAtTurnEnd(sessionId: string): void {
    const leasesOfSession = [...this.byId.values()].filter(
      (st) => st.data.ownerSessionId === sessionId && isBlocking(st.data.status),
    );
    if (leasesOfSession.length === 0) return;
    const reader = this.deps.planReaderFor();
    if (reader === undefined) return;
    const resolution = reader.isFullyResolved(sessionId); // main plan 键 = sessionId
    if (!resolution.resolved) return;
    const turnStart = this.turnStartAt.get(sessionId);
    if (turnStart !== undefined && this.deps.writeFacts.sessionLastWriteAt(sessionId) >= turnStart) return;
    for (const st of leasesOfSession) {
      st.data = { ...st.data, status: "settled" };
      this.emit("coord.settled", st.data);
    }
  }

  /** 读面前惰性清扫：settled 过 TTL 物理删；超长闲置降 ghost（不算阻塞）。 */
  private sweep(): void {
    const now = this.deps.now();
    for (const [id, st] of [...this.byId]) {
      if (st.data.status === "settled" && now - st.data.lastActivityAt > this.settleTtlMs) {
        this.byId.delete(id);
      } else if (
        (st.data.status === "active" || st.data.status === "stale") &&
        now - st.data.lastActivityAt > this.ghostAfterMs
      ) {
        st.data = { ...st.data, status: "ghost" };
      }
    }
  }

  /** 写路径 → 租约范围（项目根优先；workspace 外 → 目录前缀兜底）。 */
  private scopeOfPath(path: string): LeaseScope | undefined {
    const root = this.deps.workspaceRoot();
    const normalized = normalizeScopePath(path);
    const rootNorm = root !== undefined ? normalizeScopePath(root) : undefined;
    if (rootNorm !== undefined) {
      const project = projectRootOfAbs(rootNorm, normalized);
      if (project !== undefined) {
        return { kind: "project", projectRoot: `${rootNorm}/${project}` };
      }
      if (normalized.startsWith(`${rootNorm}/`)) {
        // workspace 内非项目文件（docs/temp 等共享面）→ 一级目录前缀
        const rel = normalized.slice(rootNorm.length + 1);
        const first = rel.split("/")[0] ?? "";
        if (first !== "") return { kind: "paths", patterns: [`${rootNorm}/${first}`] };
      }
    }
    // workspace 外写（~/.helix 等）：目录前缀（只到父目录——文件级太碎）
    const parent = normalized.slice(0, normalized.lastIndexOf("/"));
    return parent === "" ? undefined : { kind: "paths", patterns: [parent] };
  }

  /** 审计事件（sessionId = 租约归属会话；occurredAt 由 publish 面不重造——此处now）。 */
  private emit(
    type: "coord.claimed" | "coord.released" | "coord.settled" | "coord.undeclared",
    lease: OccupancyLeaseData,
    conflictWith?: readonly string[],
  ): void {
    const payload: CoordLeasePayload = {
      leaseId: lease.leaseId,
      ownerSessionId: lease.ownerSessionId,
      ownerAgentId: lease.ownerAgentId,
      scopeKind: lease.scope.kind,
      scopeDesc: describeScope(lease.scope),
      intent: lease.intent,
      source: lease.source,
      status: lease.status,
      ...(conflictWith !== undefined ? { conflictWith } : {}),
    };
    this.deps.publish({
      type,
      sessionId: lease.ownerSessionId,
      instanceId: lease.ownerAgentId,
      payload,
      occurredAt: new Date(this.deps.now()).toISOString(),
    });
  }
}
