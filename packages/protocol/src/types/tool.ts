/**
 * 工具调用条目 DTO（契约 §6；review.md mock 载体字段结构对齐：
 * 工具调用 {name, args, result, state, duration}）。
 */

export type ToolCallState = "running" | "done" | "error";

/**
 * 工具调用条目（EntryDto 的 tool-call 变体）。
 * tool.call.started 携带 state="running"；tool.call.result 携带
 * state="done"|"error" 且含 result 与 durationMs（契约 §5）。
 */
export interface ToolCallEntryDto {
  kind: "tool-call";
  id: string;
  /** 工具名（如 "run_tests"） */
  name: string;
  /** 调用参数，JSON 序列化字符串 */
  args: string;
  /** 工具结果（state=done|error 时存在；运行中无） */
  result?: string;
  state: ToolCallState;
  /** 耗时毫秒（state=done|error 时存在） */
  durationMs?: number;
  /** 创建时间（epoch 毫秒）——T1.2 定稿：线格式为 number（回填契约 §9） */
  ts: number;
  /** 实例归属（v0.1 新增，AD-3）：可选；缺省 = 主实例（"main"） */
  instanceId?: string;
  /**
   * 工具结果附带图片（v0.10 新增，T9 图片下行）：base64 data URL 数组
   * （如 browser screenshot 的截图）；聊天窗口工具卡缩略图渲染依据。
   * 缺省 = 无图工具结果（additive 纪律）。
   */
  images?: readonly string[];
}
