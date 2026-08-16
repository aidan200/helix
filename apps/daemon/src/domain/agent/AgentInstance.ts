import { DomainError } from "../DomainError";

/**
 * AgentInstance —— agent 实例一等概念（architecture.md §2，AD-3：trace 实例同构）。
 *
 * 主会话实例与 SubAgent 同为 AgentInstance（机制同构），区别仅在 kind 与
 * profile 的生命周期声明：main = persistent（常驻多轮、用户对话锚点），
 * subagent = single-shot（单轮收敛、closure 回主线后销毁）。
 *
 * 实例状态机（编排四态 + cancelled；AD-10）：
 * - queued：已创建待调度（spawn 秒回出卡）；
 * - running：执行中（stalled 是 running 上的警示非迁移，不进状态集）；
 * - done / failed：自然收口 / 崩溃收口（kill 收口 failed——单一终态语义）；
 * - cancelled：**仅在重启清队时**自 queued 收口（区别于 failed），运行期不产生。
 *
 * F1.9 非线性红线：创建/销毁是一等 API，不依赖会话按序推进；终态封闭
 * （无出边）——重派 = 新 instanceId 新实例，绝不复活终态实例。
 *
 * instanceId ≡ agentId（契约 §2 同一标识空间两视角）：主实例固定
 * MAIN_INSTANCE_ID（"main"，会话创建时分配，O-4）；SubAgent = "agent-N"
 * （序号基线 agent_lifecycle max(N)+1，分配消费方 T2.2）。
 */

/** 主实例固定 id（O-4 裁决：会话创建即分配；持久化旧行回填常量与之同源，O-3）。 */
export const MAIN_INSTANCE_ID = "main";

export type InstanceKind = "main" | "subagent";

/**
 * 实例状态（编排四态 + cancelled）。
 * 与 AgentLifecycleState（会话级运行态）是两个状态机：本态描述实例窗口
 * 生命周期，AgentLifecycleState 描述主实例会话运行态（steering/aborting 等
 * 只对主会话有意义）。
 */
export type InstanceState = "queued" | "running" | "done" | "failed" | "cancelled";

export type TerminalInstanceState = Extract<InstanceState, "done" | "failed" | "cancelled">;

/** 实例值形状（快照 instances 清单条目 / 注册表往返载荷）。 */
export interface AgentInstanceData {
  readonly instanceId: string;
  readonly kind: InstanceKind;
  /** profile 标识（如 "main-session" / "subagent-worker"）。 */
  readonly profileKind: string;
  readonly sessionId: string;
  readonly state: InstanceState;
  readonly createdAt: string;
}

/** 合法迁移矩阵（from → 允许的 to 集合）。 */
const LEGAL_TRANSITIONS: Record<InstanceState, readonly InstanceState[]> = {
  queued: ["running", "failed", "cancelled"],
  running: ["done", "failed"], // kill/崩溃/重启收口均为 failed（AD-10；cancelled 仅自 queued）
  done: [],
  failed: [],
  cancelled: [],
};

const INSTANCE_STATES: readonly InstanceState[] = ["queued", "running", "done", "failed", "cancelled"];

export class AgentInstance {
  private _state: InstanceState;

  private constructor(private readonly data: AgentInstanceData) {
    this._state = data.state;
  }

  /**
   * 创建实例（一等 API，F1.9：无会话按序推进前置）。
   * 初始态缺省 queued（SubAgent spawn 秒回出卡语义）；预算内直跑由调用方
   * 随即 markRunning()。主实例在会话创建时以 MAIN_INSTANCE_ID 创建。
   */
  static create(data: Omit<AgentInstanceData, "state"> & { state?: InstanceState }): AgentInstance {
    return new AgentInstance({ ...data, state: data.state ?? "queued" });
  }

  /** 从值形状重建（快照/持久化恢复用；保留任意合法态）。 */
  static restore(data: AgentInstanceData): AgentInstance {
    if (!INSTANCE_STATES.includes(data.state)) {
      throw new DomainError(`AgentInstance ${data.instanceId} 状态非法：${String(data.state)}`);
    }
    return new AgentInstance({ ...data });
  }

  // ── 观测面 ────────────────────────────────────────────────

  get instanceId(): string {
    return this.data.instanceId;
  }
  get kind(): InstanceKind {
    return this.data.kind;
  }
  get profileKind(): string {
    return this.data.profileKind;
  }
  get sessionId(): string {
    return this.data.sessionId;
  }
  get createdAt(): string {
    return this.data.createdAt;
  }
  get current(): InstanceState {
    return this._state;
  }
  /** 终态 = 实例窗口已销毁（done/failed/cancelled）。 */
  get isTerminal(): boolean {
    return LEGAL_TRANSITIONS[this._state].length === 0;
  }

  toData(): AgentInstanceData {
    return { ...this.data, state: this._state };
  }

  // ── 状态机（非法迁移抛 DomainError 且不改状态） ──────────

  /** 是否允许 from→to 迁移（不执行）。 */
  canTransition(to: InstanceState): boolean {
    return LEGAL_TRANSITIONS[this._state].includes(to);
  }

  transition(to: InstanceState): void {
    if (!this.canTransition(to)) {
      throw new DomainError(
        `AgentInstance ${this.instanceId} 非法迁移：${this._state} → ${to}（合法目标：${LEGAL_TRANSITIONS[this._state].join("、") || "无（终态）"}）`,
      );
    }
    this._state = to;
  }

  /** 便利断言：当前必须处于给定状态之一。 */
  assertIn(...states: InstanceState[]): void {
    if (!states.includes(this._state)) {
      throw new DomainError(
        `AgentInstance ${this.instanceId} 状态不符合预期：当前 ${this._state}，要求 ${states.join("、")}`,
      );
    }
  }

  // ── 命名迁移（语义编码：fail 自 queued|running；cancel 仅自 queued） ──

  /** 出队/预算内直跑：queued→running。 */
  markRunning(): void {
    this.transition("running");
  }

  /** 自然收口：running→done。 */
  complete(): void {
    this.transition("done");
  }

  /** 崩溃/kill/重启 running 收口（queued 也可直接收口 failed，F1.9 乱序）。 */
  fail(_reason?: string): void {
    void _reason; // 原因进 closure 记录（T2.x ClosureRecord），状态机只管状态
    this.transition("failed");
  }

  /** 重启清队收口（AD-10：仅自 queued）。 */
  cancel(): void {
    this.transition("cancelled");
  }

  /**
   * 一等销毁 API（F1.9）：从任意非终态显式收口到终态并销毁实例窗口。
   * 目标须为当前态合法迁移（如 running 不可 destroy("cancelled")）；
   * 已终态幂等 no-op。实例窗口销毁后会话聚合持续存在（AD-1 三层模型）。
   */
  destroy(final: TerminalInstanceState): void {
    if (this.isTerminal) return;
    this.transition(final);
  }
}
