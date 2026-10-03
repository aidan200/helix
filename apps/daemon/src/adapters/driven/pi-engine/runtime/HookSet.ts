import type {
  Agent,
  AgentLoopTurnUpdate,
  AgentMessage,
  AgentRequestUpdate,
  AgentTurnContext,
  AgentTurnDecision,
  BeforeToolCallContext,
  BeforeToolCallResult,
  PrepareNextTurnContext,
  PrepareRequestContext,
} from "@earendil-works/pi-agent-core";

/**
 * HookSet —— 可组合钩子处理器（architecture.md §4.2 三层抽象的第二层）。
 *
 * 编排能力的原子单位：各自订阅 pi-agent-core 的一等钩子位，
 * profile 装配即启用；作用域是钩子处理器的属性，不是目录结构（AD-15）。
 * 每个处理器**只实现自己关心的钩子位**，其余留空——组合逻辑在
 * AgentRuntime 装配期完成（beforeToolCall 链上首个 block 短路、
 * transformContext 依序串接、prepareNextTurn/prepareRequest 首个非空
 * 生效、finishTurn 任一 end 即短路否则首个非空生效）。
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
   * loop 无超时，等待时长完全由钩子方决定。
   * 返回 { block: true } 拒绝执行（reason 成为错误工具结果）。
   */
  beforeToolCall?(
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ): Promise<BeforeToolCallResult | undefined>;
  /**
   * turn 边界钩子（turn_end 之后、下一 provider 请求之前）：
   * 返回替换状态影响下一轮，返回 undefined 保持现状。
   *
   * 【接线位（deferred 批修正）】pi 0.84.4 官方通道 = Agent options 的
   * prepareNextTurnWithContext(context, signal)（agent.js 分派优先）；旧
   * prepareNextTurn 位在 loop 实现下实际收到的是 turn 对象（pi 类型
   * 声明错位）——helix 早期用旧位且各钩子忽略参数故无症状，现在统一
   * 走 WithContext 位，钩子可读 turn.context 构造精准替换（如
   * McpDeferredHooks 只换 tools 保留 messages）。
   */
  prepareNextTurn?(
    turn: PrepareNextTurnContext,
    signal?: AbortSignal,
  ): Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
  /**
   * 请求前钩子（pi 0.87 新位，agent-loop 源码核实时序）：每次对话式
   * provider 请求前运行——**含 run 首轮请求**（prepareNextTurn 不覆盖的
   * 盲区）；时点在待注入消息已 append/emit 之后、流式请求发起之前，
   * **不轮询队列**。返回非空即替换本次及后续请求的 context/model/
   * thinkingLevel（AgentRequestUpdate）。组合语义：首个非空生效（与
   * prepareNextTurn 同构——替换状态语义多钧冲突，先到先得）。
   *
   * 适配场景：回填/重建型上下文安装（在已选定输入 emit 后安装 canonical
   * context，不引入额外队列轮询）、首轮前检查类工作（如 compaction
   * request 档——重会话首轮即超阈的场景）。
   */
  prepareRequest?(
    request: PrepareRequestContext,
    signal?: AbortSignal,
  ): Promise<AgentRequestUpdate | undefined> | AgentRequestUpdate | undefined;
  /**
   * turn 收口钩子（pi 0.87 新位）：assistant 消息与全部工具结果 finalize
   * 之后、turn_end 之前运行——对 normal/error/aborted 三种终止都运行
   * （error/aborted 是硬出口，决策被 loop 忽略，仅作观测点）。
   *
   * 决策语义（agent-loop 源码核实）：{action:"end"} = 不轮询队列、跳过
   * prepareNextTurn，直接结束 run（steer/followUp 队列原封保留）；
   * {action:"continue"} = 保证一次后续请求——已有 toolResult/steer/
   * followUp 调度可满足则复用（不追加请求），否则补一次纯上下文请求；
   * undefined = 保持自然调度。组合语义：任一钩子裁决 end 即短路返回
   * （终止优先——后续钩子的 continue 无意义），否则首个非空生效。
   */
  finishTurn?(
    turn: AgentTurnContext,
    signal?: AbortSignal,
  ): Promise<AgentTurnDecision | undefined> | AgentTurnDecision | undefined;
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

/** followUp 接线能力接口（管家批段B additive）：运行中入队、当前 run 收口后
 *  自动开新 run 消费——与 steer（turn 边界 drain 进当前 run）互补的输入通道。
 *  pi Agent 原生 followUp 语义（PendingMessageQueue 队列模式）直通。 */
export interface FollowUpCapable {
  /** 入队 followUp 消息（转发 agent.followUp，run 边界自动消费）。 */
  followUp(text: string): void;
}

/** 类型谓词：钩子是否具备 followUp 接线能力。 */
export function hasFollowUp(hook: HookSet): hook is HookSet & FollowUpCapable {
  const candidate = hook as unknown as Partial<FollowUpCapable>;
  return typeof candidate.followUp === "function";
}
