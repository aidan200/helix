/**
 * contracts/markers —— loop 域 E-198 打断常量与审计形状（helix-loop
 * Phase 0a 四层拆分；原 LoopTypes.ts 按主题拆六件之一，设计 §2.1）。
 *
 * `[loop:interrupt]` 前缀 = KV/审计/sediment 过滤的同源识别凭据
 * （E-198 定稿：固定常量文本，b175d8d6 文案批）。
 */
/** E-198：打断截断标记（turn 级「此处被掐」）——固定常量文本的 user 角色
 *  合成消息（外部中断事件的模型面：三角色 schema 下 user 是外部事件的唯一
 *  合法通道；固定常量 = KV/审计/sediment 过滤的同源识别凭据；provider 面
 *  user 消息恒合法）。D7（Phase 3 批语义文案对齐）：未执行的工具调用是
 *  配对入账（合成中断回执）而非丢弃——旧文案「未完成的思考/工具调用已丢弃」
 *  与配对入账语义错位，按裁决微调（[loop:interrupt] 前缀识别凭据保持）。 */
export const LOOP_INTERRUPTED_MARKER_TEXT =
  "[loop:interrupt] 上一条回复被用户中断，此处截断（已输出内容与未完句已保留，未执行的工具调用已以中断回执配对入账，未完成的思考已丢弃）";

/** E-198：完整收尾但未执行的 toolCall 合成结果（I3 配对不变量——pi 判例①
 *  同族：孤儿 toolCall 必有对应 toolResult，合成也算）。 */
export const LOOP_INTERRUPTED_TOOL_RESULT_TEXT = "【已中断】该工具调用未执行（回复被用户中断）";

/** Phase 3 R5.5：length 截断批全 fail 的合成结果文案（零执行 + 模型可重发
 *  ——pi failToolCallsFromTruncatedMessage 同族；terminate 判定恒 false）。 */
export const LOOP_TRUNCATED_TOOL_RESULT_TEXT =
  "【截断】输出长度受限，工具调用参数可能不完整——未执行；请重新发起完整调用";

/** E-198 audit：完成但被策略丢弃的块（I6 审计面——丢弃内容日志必留，
 *  审计面与模型面分离：丢弃原因不入上下文，只入调用方日志）。 */
export interface LoopAbortDroppedBlock {
  readonly kind: "thinking" | "text" | "toolCall";
  readonly reason: string;
  readonly summary: string;
}

/** E-198 audit：aborted 轮善后摘要（LoopRunResult.aborted 携带——调用方
 *  日志面；无入账且无丢弃时缺席 = 形状零漂移）。 */
export interface LoopAbortAudit {
  /** 入账消息数（安全块；截断标记在外）。 */
  readonly keptMessages: number;
  /** 完成但不可回传被丢弃的块清单。 */
  readonly droppedBlocks: readonly LoopAbortDroppedBlock[];
}
