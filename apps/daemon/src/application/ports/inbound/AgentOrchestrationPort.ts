import type { InstanceState } from "../../../domain/agent/AgentInstance";

/**
 * 编排入口端口（inbound，architecture.md §3.4）。
 *
 * 编排三工具（agent_spawn/agent_send/agent_status，driven tools）与 WS
 * 命令（agent.kill 等，driving ws-server）共用的编排入口：经本端口回到
 * SchedulerService（TR-AD-9 编排逻辑收敛），调用方不直接触 runner。
 * 本文件只有接口/类型定义（port 铁律 AG-01：零实现）。
 */

/** spawn 判定结果（SchedulerService.spawn 同形状）。 */
export type SpawnOutcome =
  | { readonly status: "run"; readonly agentId: string }
  | { readonly status: "queued"; readonly agentId: string; readonly position: number }
  | { readonly status: "rejected"; readonly error: string };

/** send 转投结果：delivered=已投给执行载体（turn 边界生效）；否则附原因说明。 */
export interface SendOutcome {
  readonly delivered: boolean;
  readonly detail: string;
}

/** kill 结果：killed=false 附中文原因（WS 侧回 connection.error，契约 §4）。 */
export type KillOutcome = { readonly killed: true } | { readonly killed: false; readonly error: string };

/** 实例状态条目（agent_status 工具/观测面取数形状）。 */
export interface AgentInstanceStatus {
  readonly agentId: string;
  readonly state: InstanceState;
  readonly profileKind: string;
  /** 被指派任务（spawn 入参留档）。 */
  readonly task?: string;
  /** FIFO 位次（仅 state=queued 携带，1 起）。 */
  readonly position?: number;
  /** 终态摘要（closure.summary；运行中/排队不携带）。 */
  readonly summary?: string;
}

export interface AgentOrchestrationPort {
  /**
   * spawn 一个 SubAgent 实例（同步秒回：不等执行收口，AD-8 异步交付）。
   * rejected 时调用方（agent_spawn 工具/WS）把错误字符串回 LLM/前端。
   */
  spawn(task: string, profileKind?: string): SpawnOutcome;
  /**
   * 向运行中实例注入消息（AD-7⑤：SchedulerService.send → runner.send →
   * transport → 子进程 stdin → Agent.steer()，turn 边界 drain 生效）。
   */
  send(agentId: string, message: string): SendOutcome;
  /** 实例状态查询：无参全量 / 有参单实例（不存在返回空数组）。 */
  status(agentId?: string): AgentInstanceStatus[];
  /**
   * 用户终止实例（任意状态幂等；契约 §8-2 单一终态：kill 收口
   * closure.status="failed"，回执 agent.killed 事件）。
   */
  kill(agentId: string): KillOutcome;
}
