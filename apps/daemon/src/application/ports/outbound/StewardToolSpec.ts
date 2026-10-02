/**
 * StewardToolSpec —— 管家工具中立规格（application 面，零引擎依赖）。
 *
 * 段B（管家迁移 pi loop）取代 LoopToolRegistration 的工具声明形态：管家
 * 八工具按此规格声明，driven 层 StewardToolBridge 投影为 pi AgentTool。
 * 形状对齐 pi execute 四参契约的中立化（toolCallId/args/signal/onUpdate），
 * 结果三态（text/isError/terminate）覆盖管家现役工具的全部出口形态。
 */

/** 工具执行上下文（中立化——pi 四参 execute 的映射面）。 */
export interface StewardToolContext {
  /** 工具调用 id（回执配对锚）。 */
  readonly toolCallId: string;
  /** run 级中断信号（协作取消面）。 */
  readonly signal?: AbortSignal;
  /** 增量输出回调（partial 文本投影——单枚内 FIFO）。 */
  onUpdate?(text: string): void;
}

/** 工具结果：text 必填；isError = 错误框定（模型知情）；terminate = 防火墙终止。 */
export interface StewardToolResult {
  readonly text: string;
  readonly isError?: boolean;
  readonly terminate?: boolean;
}

/** 管家工具中立规格（parameters = JSON Schema 对象）。 */
export interface StewardToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  execute(args: unknown, ctx: StewardToolContext): Promise<StewardToolResult>;
}
