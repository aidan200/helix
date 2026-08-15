import type {
  ToolCallRequest,
  ToolExecutionResult,
  ToolExecutorPort,
} from "../../src/application/ports/outbound/ToolExecutorPort";

/**
 * FakeToolExecutor —— ToolExecutorPort 假实现（test/mocks）。
 * 记录全部调用（断言编排是否把工具调用送到了正确的出口）并返回
 * 可脚本化的结果；真实实现（pi 内置工具接线）在 T1.5。
 */
export class FakeToolExecutor implements ToolExecutorPort {
  readonly calls: ToolCallRequest[] = [];
  /** toolName → 结果（未配置时返回 "(fake) <toolName> ok"）。 */
  results = new Map<string, ToolExecutionResult>();

  async execute(request: ToolCallRequest): Promise<ToolExecutionResult> {
    this.calls.push({ ...request });
    return (
      this.results.get(request.toolName) ?? {
        content: `(fake) ${request.toolName} 执行成功`,
        isError: false,
      }
    );
  }
}
