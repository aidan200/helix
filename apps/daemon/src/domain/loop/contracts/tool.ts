/**
 * contracts/tool —— loop 域工具契约（helix-loop Phase 0a 四层拆分；
 * 原 LoopTypes.ts 按主题拆六件之一，设计 §2.1）。
 *
 * 工具声明/上下文/结果判别/handler 形状（A1 批工具段演进位——
 * executionMode 见设计 §3.3；Phase 4 工具桥 additive 扩展：
 * LoopToolCallContext 增 onUpdate/signal 可选位）。
 */
/** 工具声明（LLM function calling 面；与 StewardLlmTool 同构）。 */
export interface LoopToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/** 工具调用上下文（dispatch 与暂停挂钩的判别面）。
 *  Phase 4 工具桥 additive 扩展（设计 §3.3）：onUpdate 流式回调位 +
 *  signal 透传位（桥消费——kernel 现状不填，LoopAgent abort 接线在 Phase 2/3）。 */
export interface LoopToolCallContext {
  readonly runId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  /** 工具执行进展回调（部分结果文本投影；单枚内 FIFO——语义定稿 R1.10）。
 *  缺席 = 无流式观测（桥投影 noop，工具可安全发 update）。 */
  readonly onUpdate?: (partial: string) => void;
  /** abort 联动信号（工具执行段可协作取消——透传到执行体；缺省无取消）。 */
  readonly signal?: AbortSignal;
}

/** 工具执行结果判别（summary = 过程帧/事件摘要覆盖面——缺省用 text 派生）。 */
export type LoopToolOutcome =
  | { readonly kind: "result"; readonly text: string; readonly isError?: boolean; readonly summary?: string }
  /** run 终止直出错误回执（propose_send 类防火墙前置拒——不回灌循环）。 */
  | { readonly kind: "terminate"; readonly reason: string };

/** 工具 handler 形状（ToolRegistry 注册项的执行面）。 */
export type LoopToolHandler = (
  args: Record<string, unknown>,
  context: LoopToolCallContext,
) => Promise<LoopToolOutcome>;
