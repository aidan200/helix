/**
 * 工具执行出口端口（outbound，architecture.md §3.4）。
 *
 * service 层工具编排的抽象边界；真实实现（T1.5：pi 内置四工具 + 自写 grep，
 * 走 ExecutionEnv）落位 adapters/driven/tools。本任务用 FakeToolExecutor。
 * 本文件只有接口定义（AG-01）。
 */

/** 一次工具调用请求。signal 供 abort 联动（架构反馈 T1.3 #4：abort 可直接透传）。 */
export interface ToolCallRequest {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly signal?: AbortSignal;
}

export interface ToolExecutionResult {
  /** 回注给模型的文本结果。 */
  readonly content: string;
  readonly isError: boolean;
}

export interface ToolExecutorPort {
  execute(request: ToolCallRequest): Promise<ToolExecutionResult>;
}
