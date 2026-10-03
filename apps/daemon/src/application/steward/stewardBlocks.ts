/**
 * stewardBlocks —— 管家 LLM 块集投影助手（纯函数）。
 *
 * 历史：原 domain/loop/contracts/message.ts（loop 域消息契约），段C 内核
 * 退役迁入 application 层自持——两个消费面（voice 播报摘要、会话主题
 * 演进）都在 StewardLlmPort 单轮响应链上。类型锚 StewardLlmContentBlock
 * （port 类型文件按 AG-01 只承载类型，函数落本件）。
 */

import type { StewardLlmContentBlock } from "../ports/outbound/StewardLlmPort";

/** 块集内 text 块拼接（终答投影——终答可能多 text 块，拼接即全文）。 */
export function stewardBlocksText(blocks: readonly StewardLlmContentBlock[]): string {
  let out = "";
  for (const b of blocks) {
    if (b.type === "text") out += b.text;
  }
  return out;
}

/** 块集内首枚 toolCall 块（单枚语义提取面；缺席 = 纯文本轮）。 */
export function firstToolCallBlock(
  blocks: readonly StewardLlmContentBlock[],
): StewardLlmContentBlock & { type: "toolCall" } | undefined {
  for (const b of blocks) {
    if (b.type === "toolCall") return b;
  }
  return undefined;
}
