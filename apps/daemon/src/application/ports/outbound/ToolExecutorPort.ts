/**
 * 工具执行出口端口（outbound，architecture.md §3.4）。
 *
 * 【契约预留】当前生产链路零 execute 调用——真实工具装配走
 * CoreToolExecutor 内部 resolveTools（工具表 → pi AgentTool 形态）不经
 * 本端口；本接口固定「一次工具调用的请求/结果形状」供 CoreToolExecutor
 * 真体与测试替身同形互换（FakeToolExecutor 已随零引用下线）。真实实现
 * （pi 内置四工具 + 自写 grep，走 ExecutionEnv）落位 adapters/driven/tools。
 * 本文件只有接口定义（AG-01）。
 */

/** 一次工具调用请求。signal 供 abort 联动（abort 可直接透传）。 */
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
  /**
   * 工具结果附带图片：base64 data URL 数组（如 browser
   * screenshot 截图）——聊天窗工具卡缩略图数据源；缺省 = 无图（旧形态）。
   */
  readonly images?: readonly string[];
}

export interface ToolExecutorPort {
  execute(request: ToolCallRequest): Promise<ToolExecutionResult>;
}
