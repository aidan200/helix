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
 * 状态机的权威性与可观测性都由本聚合保证（runtime 不自持副本）。
 *
 * 【实例注册表语义（AD-3， 演进）】本类同时是会话内
 * 实例注册表：主实例与 SubAgent 在此注册/出册。实例 id 统一为
 * `agent-<唯一串>`（T10a 方案 A，生成单点 AgentInstance.newInstanceId；
 * legacy 字面 "main" 仅只读兼容，见 LEGACY_MAIN_INSTANCE_ID）。
 * 注册/出册不依赖会话按序推进（非线性红线）；注册表与主实例会话运行态
 * （上述五态矩阵）彼此独立——实例窗口生命周期由 AgentInstance 状态机承载。
 * 投影面：agent_lifecycle 表 PK (session_id, instance_id)。
 *
 * 【终态保留窗口（CAND-399）】注册表内终态实例只保留最近 N 条
 * （terminalOrder 序，noteTerminal 登记），超窗者销户（trimTerminalWindow）
 * ——daemon 生命周期内注册表内存占用与 status() 全量序列化体量有界；
 * 持久化观测面（closure_records/agent_lifecycle 投影）不随销户变化。
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
  /**
   * 转终态登记序（instanceId 按转终态先后；CAND-399 终态保留窗口的序源）。
   * 编排层在实例收口后调 noteTerminal 登记；restore 原样恢复的终态实例按
   * 注册序入列（重启场景近似序）。非终态实例不进序。
   */
  private readonly terminalOrder: string[] = [];

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

  // ── 实例注册表（AD-3：会话内实例一等注册； 不假设按序推进） ──

  /** 注册实例（主实例与 SubAgent 同空间 `agent-<唯一串>` id；重复 id 抛错且不产生半态）。 */
  registerInstance(instance: AgentInstance): void {
    if (this.instances.has(instance.instanceId)) {
      throw new DomainError(`实例 ${instance.instanceId} 已在会话内注册，不可重复注册`);
    }
    this.instances.set(instance.instanceId, instance);
    // restore 链终态原样恢复：注册即入终态序（注入序近似重启前终态序）
    if (instance.isTerminal) this.terminalOrder.push(instance.instanceId);
  }

  /**
   * 出册实例（一等销毁 API 的注册面；任意状态可出册——窗口销毁是编排决策，
   * 不依赖会话推进）。返回被出册的实例（不存在时 undefined，幂等）。
   */
  unregisterInstance(instanceId: string): AgentInstance | undefined {
    const instance = this.instances.get(instanceId);
    this.instances.delete(instanceId);
    const idx = this.terminalOrder.indexOf(instanceId);
    if (idx >= 0) this.terminalOrder.splice(idx, 1); // 终态序同步摘除（防陈旧 id 累积）
    return instance;
  }

  /**
   * 转终态登记（CAND-399）：编排层在实例收口链完成后调用——终态保留窗口的
   * 序源（保留「最近」N 条以本序为准）。不在册/重复登记忽略（幂等）。
   */
  noteTerminal(instanceId: string): void {
    if (!this.instances.has(instanceId)) return;
    if (this.terminalOrder.includes(instanceId)) return;
    this.terminalOrder.push(instanceId);
  }

  /**
   * 终态保留窗口裁剪（CAND-399）：保留最近 keep 条终态 subagent 实例，超窗者
   * 出册销户（返回被销户实例，旧→新序，调用方据此对齐清理门面侧留档）。
   * 主实例与非终态实例永不裁剪（防御位：终态序里只应有终态 subagent）。
   * 陈旧序 id（已出册）随裁剪丢弃；未超窗时 no-op。幂等。
   */
  trimTerminalWindow(keep: number): AgentInstance[] {
    // 第一遍：过滤陈旧 id（已出册）得在册序；终态 subagent 计数定裁剪起点
    const live = this.terminalOrder.filter((id) => this.instances.has(id));
    const terminalIds = live.filter((id) => {
      const instance = this.instances.get(id)!;
      return instance.isTerminal && instance.kind !== "main";
    });
    // 保留最近 keep 条 = 最旧（terminalIds.length - keep）条销户
    const cutoff = Math.max(0, terminalIds.length - Math.max(0, keep));
    const evictSet = new Set(terminalIds.slice(0, cutoff));
    const evicted: AgentInstance[] = [];
    const retained: string[] = [];
    for (const id of live) {
      if (evictSet.has(id)) {
        const removed = this.instances.get(id)!;
        this.instances.delete(id);
        evicted.push(removed);
        continue;
      }
      retained.push(id);
    }
    this.terminalOrder.length = 0;
    this.terminalOrder.push(...retained);
    return evicted;
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
