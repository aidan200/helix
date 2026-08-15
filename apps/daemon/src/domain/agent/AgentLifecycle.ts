import { DomainError } from "../DomainError";

/**
 * agent 生命周期状态机（architecture.md §3.3，AD-16：domain 唯一权威状态）。
 *
 * 状态语义：
 * - idle：空闲，可接受新输入开新 turn；
 * - running：一次 run 进行中（流式生成/工具执行）；
 * - steering：running 期间收到注入（steer 已入队，等待 turn 边界 drain）；
 * - aborting：已请求中断，等待当前 run 收尾；
 * - stopped：daemon 停止（终态，会话不再接受输入）。
 *
 * 非法迁移（如 idle→steering、stopped→任何）抛 DomainError，且不改状态——
 * 状态机的权威性与可观测性都由本聚合保证（TP-CL4-5：runtime 不自持副本）。
 */
export type AgentLifecycleState = "idle" | "running" | "steering" | "aborting" | "stopped";

/** 合法迁移矩阵（from → 允许的 to 集合）。 */
const LEGAL_TRANSITIONS: Record<AgentLifecycleState, readonly AgentLifecycleState[]> = {
  idle: ["running", "stopped"],
  running: ["idle", "steering", "aborting", "stopped"],
  steering: ["running", "idle", "aborting", "stopped"],
  aborting: ["idle", "stopped"],
  stopped: [],
};

export class AgentLifecycle {
  private _state: AgentLifecycleState = "idle";

  get current(): AgentLifecycleState {
    return this._state;
  }

  /** 是否允许 from→to 迁移（不执行）。 */
  canTransition(to: AgentLifecycleState): boolean {
    return LEGAL_TRANSITIONS[this._state].includes(to);
  }

  /** 执行迁移；非法迁移抛 DomainError 且保持原状态。 */
  transition(to: AgentLifecycleState): void {
    if (!this.canTransition(to)) {
      throw new DomainError(
        `agent 生命周期非法迁移：${this._state} → ${to}（合法目标：${LEGAL_TRANSITIONS[this._state].join("、") || "无（终态）"}）`,
      );
    }
    this._state = to;
  }

  /** 便利断言：当前必须处于给定状态之一，否则抛错。 */
  assertIn(...states: AgentLifecycleState[]): void {
    if (!states.includes(this._state)) {
      throw new DomainError(`agent 生命周期状态不符合预期：当前 ${this._state}，要求 ${states.join("、")}`);
    }
  }
}
