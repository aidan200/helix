import { DomainError } from "../DomainError";
import type { AgentInstance } from "./AgentInstance";

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
 *
 * 【实例注册表语义（AD-3，iter-20260816-uzvg T1.2 演进）】本类同时是会话内
 * 实例注册表：主实例（固定 id main）与 SubAgent（agent-N）在此注册/出册。
 * 注册/出册不依赖会话按序推进（F1.9 非线性红线）；注册表与主实例会话运行态
 * （上述五态矩阵）彼此独立——实例窗口生命周期由 AgentInstance 状态机承载。
 * 投影面：agent_lifecycle 表 PK (session_id, instance_id)。
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
  /** 会话内实例注册表（instanceId → 实例；注册即入册，出册即销毁窗口）。 */
  private readonly instances = new Map<string, AgentInstance>();

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

  // ── 实例注册表（AD-3：会话内实例一等注册；F1.9 不假设按序推进） ──

  /** 注册实例（主实例 main 固定 id；重复 id 抛错且不产生半态）。 */
  registerInstance(instance: AgentInstance): void {
    if (this.instances.has(instance.instanceId)) {
      throw new DomainError(`实例 ${instance.instanceId} 已在会话内注册，不可重复注册`);
    }
    this.instances.set(instance.instanceId, instance);
  }

  /**
   * 出册实例（一等销毁 API 的注册面；任意状态可出册——窗口销毁是编排决策，
   * 不依赖会话推进）。返回被出册的实例（不存在时 undefined，幂等）。
   */
  unregisterInstance(instanceId: string): AgentInstance | undefined {
    const instance = this.instances.get(instanceId);
    this.instances.delete(instanceId);
    return instance;
  }

  /** 按 id 查实例。 */
  findInstance(instanceId: string): AgentInstance | undefined {
    return this.instances.get(instanceId);
  }

  /** 全部实例（注册序）。 */
  listInstances(): AgentInstance[] {
    return [...this.instances.values()];
  }

  get instanceCount(): number {
    return this.instances.size;
  }
}
