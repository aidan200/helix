import type {
  Agent,
  AgentLoopTurnUpdate,
  AgentMessage,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";

/**
 * HookSet —— 可组合钩子处理器（architecture.md §4.2 三层抽象的第二层）。
 *
 * 编排能力的原子单位：各自订阅 pi-agent-core 的一等钩子位，
 * profile 装配即启用；作用域是钩子处理器的属性，不是目录结构（AD-15）。
 * 每个处理器**只实现自己关心的钩子位**，其余留空——组合逻辑在
 * AgentRuntime 装配期完成（beforeToolCall 链上首个 block 短路、
 * transformContext 依序串接、prepareNextTurn 首个非空生效）。
 */
export interface HookSet {
  /** 处理器名（装配诊断/日志用）。 */
  readonly name: string;
  /**
   * 装配回调：AgentRuntime 组装 Agent 后调用一次——钩子在此拿到
   * agent 引用完成自身接线（如 steer/abort 转发、事件订阅）。
   */
  bind?(agent: Agent): void;
  /**
   * 工具执行前钩子（挂起语义：返回的 Promise 未决即挂起工具执行，
   * loop 无超时，等待时长完全由钩子方决定——spike §5.2）。
   * 返回 { block: true } 拒绝执行（reason 成为错误工具结果）。
   */
  beforeToolCall?(
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ): Promise<BeforeToolCallResult | undefined>;
  /**
   * turn 边界钩子（turn_end 之后、下一 provider 请求之前）：
   * 返回替换状态影响下一轮，返回 undefined 保持现状。
   */
  prepareNextTurn?(
    signal?: AbortSignal,
  ): Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
  /**
   * 上下文变换（外部注入等扩展点）。契约：不得抛错，安全降级返回原消息。
   */
  transformContext?(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]>;
}

/**
 * steer/abort 接线能力接口：AgentRuntime 经此能力接口委托驱动动作，
 * 不耦合具体钩子类（装配了具备该能力的 HookSet 即获得 steer/abort 通道）。
 */
export interface SteerCapable {
  /** 运行中注入（转发 agent.steer，即时入队、turn 边界 drain）。 */
  steer(text: string): void;
  /** 中断当前 run（触发本钩子接线的 AbortController + agent.abort）。 */
  abort(): void;
}

/** 类型谓词：钩子是否具备 steer/abort 接线能力。 */
export function hasSteer(hook: HookSet): hook is HookSet & SteerCapable {
  const candidate = hook as unknown as Partial<SteerCapable>;
  return typeof candidate.steer === "function" && typeof candidate.abort === "function";
}
