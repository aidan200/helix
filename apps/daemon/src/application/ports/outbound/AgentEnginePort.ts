/**
 * agent 引擎出口端口（outbound，architecture.md §3.4）。
 *
 * pi 引擎被防腐在这一面墙后（§3.5）：service 只看到
 * 「驱动 / 注入 steer / 中断」三个动作 + 引擎事件回调。
 * 本文件只有类型/接口（AG-01），事件形状是 daemon 自己的契约
 * （与 pi 的 AgentEvent 一一对应但互不 import——映射在 PiAgentEngineAdapter）。
 */

/**
 * 引擎事件（时序契约 = T1.3 spike 报告 §5，FakeAgentEngine 与
 * PiAgentEngineAdapter 双实现等价时序）：
 * - 无工具轮：agent_start → turn_start → message_start(user) → message_end(user)
 *   → message_start(assistant) → message_update×N → message_end(assistant)
 *   → turn_end{toolResultCount:0} → agent_end；
 * - steer drain 边界 = turn_end 之后、下一 turn_start 之前（§5.3）；
 * - abort 轮以 message_end(assistant, stopReason="error") 收尾（§5.1）。
 */
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
      readonly type: "message_end";
      readonly role: "user" | "assistant" | "toolResult";
      readonly text: string;
      /** assistant 消息的停止原因（abort/错误时 "error"，正常 "stop"/"toolUse" 等）。 */
      readonly stopReason?: string;
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
    }
  | { readonly type: "engine_error"; readonly message: string };

export type AgentEngineListener = (event: AgentEngineEvent) => void;

export interface AgentEnginePort {
  /**
   * 驱动一轮 run：从用户输入开始直到 run 结束（含工具轮与 steer drain 轮）。
   * listener 在 run 期间持续收到引擎事件；Promise 在 run 完全结束后 resolve。
   */
  start(input: string, listener: AgentEngineListener): Promise<void>;
  /** 运行中注入 steer 消息（即时入队，turn 边界 drain——不打断当前工具/生成）。 */
  steer(text: string): void;
  /** 中断当前 run（非销毁：之后可继续 start 新对话）。 */
  abort(): void;
  /** 是否正在 run 中。 */
  isStreaming(): boolean;
}
