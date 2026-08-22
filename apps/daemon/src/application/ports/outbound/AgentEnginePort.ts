/**
 * agent 引擎出口端口（outbound，architecture.md §3.4）。
 *
 * pi 引擎被防腐在这一面墙后（§3.5）：service 只看到
 * 「驱动 / 注入 steer / 中断」三个动作 + 引擎事件回调。
 * 本文件只有类型/接口（AG-01），事件形状是 daemon 自己的契约
 * （与 pi 的 AgentEvent 一一对应但互不 import——映射在 PiAgentEngineAdapter）。
 */

/**
 * 引擎事件（时序契约 §5；FakeAgentEngine 与
 * PiAgentEngineAdapter 双实现等价时序）：
 * - 无工具轮：agent_start → turn_start → message_start(user) → message_end(user)
 *   → message_start(assistant) → message_update×N → message_end(assistant)
 *   → turn_end{toolResultCount:0} → agent_end；
 * - steer drain 边界 = turn_end 之后、下一 turn_start 之前（§5.3）；
 * - abort 轮以 message_end(assistant, stopReason="error") 收尾（§5.1）。
 *
 * 通道族 additive：thinking 三事件（assistant 消息内的 thinking 块流，
 * 先于文本 delta）、message_end 载荷 +usage?（七字段防腐提取，账目本体归
 * UsageLedger）、compaction_completed（turn 边界压缩产物，tokensAfter 为压缩后
 * estimateContextTokens 复算值）。
 */

/** 引擎侧用量（契约 §6.2 UsageDto 的 port 镜像：七字段全显式，cost 拍平为 number）。 */
export interface AgentEngineUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning: number;
  readonly totalTokens: number;
  readonly cost: number;
}
export type AgentEngineEvent =
  | { readonly type: "agent_start" }
  | { readonly type: "agent_end"; readonly messageCount: number }
  | { readonly type: "turn_start" }
  | { readonly type: "turn_end"; readonly toolResultCount: number }
  | {
      readonly type: "message_start";
      readonly role: "user" | "assistant" | "toolResult";
      /** user 消息来源：prompt 输入 / steer 队列 drain 注入（可观测点，§5.3）。 */
      readonly source: "prompt" | "steer-drain";
    }
  | { readonly type: "message_update"; readonly delta: string }
  | {
      /** thinking 块流开始（assistant 消息内，先于文本 delta；contentIndex 对应块位）。 */
      readonly type: "thinking_started";
      readonly contentIndex: number;
    }
  | {
      /** thinking 块流增量（中间态，不落盘——经流式通道直达前端）。 */
      readonly type: "thinking_delta";
      readonly contentIndex: number;
      readonly delta: string;
    }
  | {
      /** thinking 块完成（content 为该块全文；完成态由上层落 ThinkingEntry）。 */
      readonly type: "thinking_end";
      readonly contentIndex: number;
      readonly content: string;
    }
  | {
      readonly type: "message_end";
      readonly role: "user" | "assistant" | "toolResult";
      readonly text: string;
      /** assistant 消息的停止原因（abort/错误时 "error"，正常 "stop"/"toolUse" 等）。 */
      readonly stopReason?: string;
      /** 本 turn 用量（assistant 消息携带时提取；七字段，cost 拍平——账目归 UsageLedger）。 */
      readonly usage?: AgentEngineUsage;
    }
  | {
      readonly type: "tool_execution_start";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: unknown;
    }
  | {
      readonly type: "tool_execution_end";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly isError: boolean;
      readonly result: string;
      /** 工具结果附带图片（下行）：base64 data URL 数组（如截图）；缺省 = 无图。 */
      readonly images?: readonly string[];
    }
  | {
      /** turn 边界 compaction 完成（CompactResult 防腐映射；tokensAfter = 压缩后复算）。 */
      readonly type: "compaction_completed";
      readonly tokensBefore: number;
      readonly tokensAfter: number;
      readonly summary: string;
      /** 摘要调用量（provider 上报时携带；缺省 = 未报）。 */
      readonly usage?: AgentEngineUsage;
    }
  | { readonly type: "engine_error"; readonly message: string };

export type AgentEngineListener = (event: AgentEngineEvent) => void;

export interface AgentEnginePort {
  /**
   * 驱动一轮 run：从用户输入开始直到 run 结束（含工具轮与 steer drain 轮）。
   * listener 在 run 期间持续收到引擎事件；Promise 在 run 完全结束后 resolve。
   * 图片上行：images 可选（已校验的 base64 data URL 数组）——驱动侧
   * （AgentRuntime）解码为 ImageContent[] 后经 agent.prompt(input, images)
   * 注入模型；缺省 = 纯文本（旧行为零变更）。
   */
  start(input: string, listener: AgentEngineListener, images?: readonly string[]): Promise<void>;
  /** 运行中注入 steer 消息（即时入队，turn 边界 drain——不打断当前工具/生成）。 */
  steer(text: string): void;
  /** 中断当前 run（非销毁：之后可继续 start 新对话）。 */
  abort(): void;
  /** 是否正在 run 中。 */
  isStreaming(): boolean;
  /**
   * 当前模型 id（"provider/model-id"；模型族可观测面——徽标/快照
   * model 位数据源）。未实现/引擎未装配模型 → undefined（调用方回退默认）。
   */
  currentModel?(): string | undefined;
  /**
   * 运行期换模（AD-2：AgentState.model 直改，下一 turn 生效——
   * in-flight run 不受影响（run 级 loop config 已快照模型）；不走
   * prepareNextTurn 链（CompactionHook 占用且首个非空短路）。实现体在
   * pi-engine 域（TR-AD-2 域内扩 port 面）。
   */
  setModel?(modelId: string): void;
  /**
   * 运行期改生效工具集（setModel 同构）：names 经引擎侧 resolveTools
   * 重解析成 AgentTool[] 后直改 AgentState.tools（能力+提示双料事实源），
   * 下一 turn 生效（in-flight 不变）。入参 = ResourceService.getEffectiveTools
   * 生效集（resolveTools 产物同源派生）。
   */
  setTools?(names: readonly string[]): void;
  /**
   * 运行期改系统提示（setModel 同构）：AgentState.systemPrompt 直改，
   * 下一 turn 生效。入参 = SystemPromptAssembler 三段组装产物。
   */
  setSystemPrompt?(text: string): void;
}
