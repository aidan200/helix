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

/**
 * park 结果（⑤ 链 C，与 SchedulerService.park 同形）：parked=true = 请求已
 * 受理（协议指令经 steer 通道注入，状态转 parked 待子进程 PARK 确认上行
 * ——回合边界生效）；拒绝附中文原因（不存在/终态/排队中/非 subagent）。
 */
export type ParkOutcome = { readonly parked: true } | { readonly parked: false; readonly error: string };

/**
 * resume 结果（⑤ 链 C，与 SchedulerService.resume 同形）：预算内立即恢复；
 * queued=true = 预算满与重派同队排队（P3，空位后机械恢复不重新 launch）；
 * 拒绝附中文原因。
 */
export type ResumeOutcome =
  | { readonly resumed: true; readonly queued: false }
  | { readonly resumed: true; readonly queued: true; readonly position: number }
  | { readonly resumed: false; readonly error: string };

/** 实例状态条目（agent_status 工具/观测面取数形状）。 */
export interface AgentInstanceStatus {
  readonly agentId: string;
  readonly state: InstanceState;
  readonly profileKind: string;
  /** 被指派任务（spawn 入参留档）。 */
  readonly task?: string;
  /** FIFO 位次（queued 与排队恢复中的 parked 携带，1 起）。 */
  readonly position?: number;
  /** 终态摘要（closure.summary；运行中/排队不携带）。 */
  readonly summary?: string;
  /** 挂起原因（park/resume 批；仅 state=parked 携带）。 */
  readonly parkedReason?: "user" | "taskPause";
  /** 挂起时刻（ISO 8601；仅 state=parked 携带）。 */
  readonly parkedAt?: string;
}

/** 执行轨迹项（T3-B 环缓冲元素；tool → name，assistant → text 尾部 200 字）。 */
export interface AgentTraceItem {
  /** 到达时刻（ISO 8601，ClockPort.now()）。 */
  readonly t: string;
  readonly kind: "tool" | "assistant";
  /** 工具名（kind=tool 携带）。 */
  readonly name?: string;
  /** assistant 消息文本尾部 200 字（kind=assistant 携带）。 */
  readonly text?: string;
}

/**
 * 实例执行核实视图（T3-B agent_inspect 工具取数形状）：进展报告连续零增量
 * 时 MainAgent 核实真实执行轨迹（是否死循环）；确无进展可 kill 重派——
 * 裁决归 MainAgent，系统只送达信息。
 */
export interface AgentInspection {
  readonly instanceId: string;
  readonly state: InstanceState;
  /** 被指派任务（spawn 入参留档；缺载实例不携带）。 */
  readonly task?: string;
  /** 实例创建时刻（ISO 8601）。 */
  readonly startedAt: string;
  /** 最近引擎事件时刻（epoch ms；终态/无事件 → null）。 */
  readonly lastEventAt: number | null;
  /** 静默时长 ms（now − lastEventAt；终态/无事件 → null）。 */
  readonly idleMs: number | null;
  /** 工具调用完成累计数（translator 机械计数器；终态清零）。 */
  readonly toolCalls: number;
  /** 最近 20 条执行轨迹（时间序；溢出逐最旧；终态清空）。 */
  readonly trace: readonly AgentTraceItem[];
}

export interface AgentOrchestrationPort {
  /**
   * spawn 一个 SubAgent 实例（同步秒回：不等执行收口，AD-8 异步交付）。
   * rejected 时调用方（agent_spawn 工具/WS）把错误字符串回 LLM/前端。
   *
   * reportIntervalMs（T3-A 过程监督）：周期进展报告间隔毫秒——>0 启用
   * per-instance 定时器，按间隔经 injectClosure 通道向归属会话注入一行
   * 机械 Δ 信封（工具调用/输出字符/轮次增量 + idleMs 静默）；缺省/0/
   * 负数/NaN = 不报告。系统只送达信息，永不自动终止（裁决归 MainAgent）。
   */
  spawn(task: string, profileKind?: string, reportIntervalMs?: number): SpawnOutcome;
  /**
   * 向运行中实例注入消息（AD-7⑤：SchedulerService.send → runner.send →
   * transport → 子进程 stdin → Agent.steer()，turn 边界 drain 生效）。
   */
  send(agentId: string, message: string): SendOutcome;
  /** 实例状态查询：无参全量 / 有参单实例（不存在返回空数组）。 */
  status(agentId?: string): AgentInstanceStatus[];
  /**
   * 实例执行核实（T3-B）：状态/静默/累计工具数/最近 20 条轨迹。
   * 不存在 → null（与 status 空数组同族的空值语义）。
   */
  inspect(agentId: string): AgentInspection | null;
  /**
   * 用户终止实例（任意状态幂等；契约 §8-2 单一终态：kill 收口
   * closure.status="failed"，回执 agent.killed 事件）。
   */
  kill(agentId: string): KillOutcome;
  /**
   * 挂起运行中实例（⑤ 链 C chat 域入口：reason 恒 user——任务域批量挂起
   * （taskPause）归 TaskEngine 接线，不经本端口）。协议指令经 steer 通道
   * 注入，状态转 parked 待子进程 PARK 确认上行；幂等/终态赢/排队中拒绝。
   */
  park(agentId: string): ParkOutcome;
  /** 恢复挂起实例（同一实例同一会话从断点继续；预算满与重派同队排队，P3）。 */
  resume(agentId: string): ResumeOutcome;
}
