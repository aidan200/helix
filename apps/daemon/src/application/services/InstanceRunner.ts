import type { AgentInstance } from "../../domain/agent/AgentInstance";
import type { InstanceClosurePayload } from "../../domain/events/DomainEvent";
import type { AgentEngineEvent } from "../ports/outbound/AgentEnginePort";

/**
 * InstanceRunner —— SubAgent 实例运行器接缝（application 内部接口）。
 *
 * SchedulerService 只管编排语义（预算/队列/stalled/收口事件与落盘）；
 * 「驱动一个实例真体执行 task」由本接口的实现承载：
 * SubagentLauncher（子进程 spawn + transport）是真体；替身
 * （FakeAgentEngine 驱动）跑 integration。这不是 outbound port——
 * 它是编排服务对「实例执行载体」的内部接缝（编排三工具经
 * AgentOrchestrationPort 进调度，不直接触 runner）。
 */

/** 实例收口上报：result 区分三条收口路径（映射 agent.completed/failed/killed）。 */
export interface InstanceClosureOutcome {
  /**
   * done=自然收口；failed=崩溃/异常收口；killed=用户 kill 收口
   * （closure.status 均由上报方构造——kill 为 "failed"，单一终态语义）。
   */
  readonly result: "done" | "failed" | "killed";
  readonly closure: InstanceClosurePayload;
  /** failed 路径的错误说明（agent.failed.error；缺省取 closure.summary）。 */
  readonly error?: string;
}

/** SchedulerService 注入给 runner 的回调（事件增量 + 收口）。 */
export interface InstanceRunnerCallbacks {
  /**
   * 实例引擎事件增量到达（任意事件类型）：刷新该实例 lastEventAt——
   * stalled 判定的唯一输入。未知/已终态实例的迟到事件被调度侧忽略。
   *
   * 携帯引擎事件本体（可选——SubAgent 内部工具调用据此转 per-instance
   * 领域事件，挂 instanceId 落盘+广播；不进主线聚合，AD-8 铁律）。
   * 缺省 undefined = 仅增量记号（替身/测试驱动面兼容）。
   */
  onInstanceEvent(instanceId: string, event?: AgentEngineEvent): void;
  /**
   * 实例收口（done/failed/killed）。调度侧幂等：对已终态实例的重复/迟到
   * 回调为 no-op（kill 与自然收口竞态的后到者被吞）。
   */
  onInstanceClosure(instanceId: string, outcome: InstanceClosureOutcome): void;
  /**
   * 实例挂起确认（park/resume 批，可选成员——挂起能力载体才实现）：子进程
   * 检测 PARK 标记进入挂起等待（不收口不退出）时上报；progress/next 摘要
   * 随行。调度侧幂等：非 running 态实例的迟到 parked 行忽略（park 与自然
   * 收口竞态 = 终态赢，park 迟到作废）。
   */
  onInstanceParked?(instanceId: string, summary: { progress: string; next: string }): void;
}

export interface InstanceRunner {
  /**
   * 启动实例执行 task（异步交付：launch 不 await 收口——closure 经回调上报；
   * spawn 工具秒回语义在调度侧，AD-8）。同一实例不重复 launch。
   */
  launch(instance: AgentInstance, task: string): void;
  /**
   * 回调注入（组合根装配时由 SchedulerService 构造后接线；
   * 实现方保存并在引擎事件/收口时回调）。
   */
  setCallbacks(callbacks: InstanceRunnerCallbacks): void;
  /**
   * steer 转投通道（AD-7⑤）：SchedulerService.send → 本方法 →
   * transport → 子进程 stdin send 行 → Agent.steer()。未知/已收口实例
   * 静默忽略。可选成员——未实现者（占位替身）不支持注入。
   */
  send?(instanceId: string, text: string): void;
  /**
   * kill 通道（收口前终止修复）：SchedulerService.kill 在收口前调用，
   * 通知 runner 终止子进程（O-6 序列）——否则用户 kill 后子进程跑到自然
   * 收口（幂等吞迟到回调但进程仍耗资源）。可选成员——未实现者仅收口不
   * 发终止信号（与替身行为一致）。返回值仅诊断用（如 graceful/
   * escalated），调度侧不依赖。
   */
  kill?(instanceId: string): void | Promise<unknown>;
}
