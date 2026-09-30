/**
 * kernel/AbortSettler —— E-198 打断善后内核（helix-loop Phase 0a 四层拆分；
 * 设计 §2.2：原 LoopEngine.settleAbortedTurn 独立成件——依赖注入
 * recordMessage，独立可测）。
 *
 * E-198 打断善后内核（§2.1 partial 保留）：安全块入账 + 截断标记 + 不安全块丢弃。
 *  - 完整性唯一凭证 = 块 end（I1）：入参 blocks 只含已收 end 的块；
 *  - G1（duplex-truncation §3.3 text 行定稿）：未关账半截 text 经 partialText
 *    入账（与完成块同批，流序恒尾部）——文本无配对/签名约束全 provider
 *    安全，模型须记得被掐断的已播半句（P2）；partialText 缺席/空 = 无半截
 *    text，行为与 G1 前完全一致；partialText 只含未关账增量（adapter 保证
 *    不含已关账块，防重复入账）；
 *  - 半截 thinking/toolCall（无 end）无帧不入账（I2）；策略丢弃（完成但不可
 *    回传）：无签名 thinking（pi 判例③）与尾部悬挂 thinking（无后继内容块
 *    ——单独回传 = "reasoning without following item" 类 provider 拒绝，pi
 *    判例①同族；半截 text 作为后继内容块可合法承接签名 thinking）→ audit
 *    记录（I6）；
 *  - 完整 toolCall 未执行 → 合成中断 toolResult 配对（I3，pi 判例①同族）；
 *  - 截断标记（turn 级）永远落一枚：零安全块时也告知模型被掐（连续性），
 *    多次打断跨 run 各自累积不重复（T6）。
 */
import type { LoopAbortAudit, LoopAbortDroppedBlock, LoopMessage, LoopStreamBlock, LoopThinking } from "../contracts";
import { LOOP_INTERRUPTED_MARKER_TEXT, LOOP_INTERRUPTED_TOOL_RESULT_TEXT } from "../contracts/markers";

/** E-198 打断善后（转录入账经注入的 record 单写者——与 kernel recordMessage
 *  同序：push 窗口 + onNewMessage 串行保序）。 */
export async function settleAbortedTurn(
  record: (message: LoopMessage) => Promise<void>,
  blocks: readonly LoopStreamBlock[],
  partialText?: string,
): Promise<LoopAbortAudit | undefined> {
  const dropped: LoopAbortDroppedBlock[] = [];
  let pendingThinking: LoopThinking | undefined;
  let textParts: string[] = [];
  let keptCount = 0;
  const flushText = async (): Promise<void> => {
    if (textParts.length === 0) return;
    const assistant: LoopMessage = {
      role: "assistant",
      text: textParts.join("\n\n"),
      ...(pendingThinking !== undefined ? { thinking: pendingThinking } : {}),
    };
    pendingThinking = undefined;
    textParts = [];
    await record(assistant);
    keptCount += 1;
  };
  for (const block of blocks) {
    if (block.kind === "thinking") {
      await flushText(); // thinking 后置于文本时归属切分：先落前文（thinking 归属后续块）
      if (block.signature === undefined || block.signature === "") {
        dropped.push({ kind: "thinking", reason: "无签名不可回传（pi 判例③）", summary: block.text.slice(0, 80) });
        continue;
      }
      pendingThinking =
        pendingThinking === undefined
          ? { text: block.text, signature: block.signature }
          : { text: `${pendingThinking.text}\n${block.text}`, signature: pendingThinking.signature };
      continue;
    }
    if (block.kind === "text") {
      if (block.text !== "") textParts.push(block.text);
      continue;
    }
    // toolCall：完整收尾但未执行（打断在流式段——工具段不打断，§6.2）
    await flushText();
    const assistant: LoopMessage = {
      role: "assistant",
      ...(pendingThinking !== undefined ? { thinking: pendingThinking } : {}),
      toolCall: { id: block.id, name: block.name, args: block.args },
    };
    pendingThinking = undefined;
    await record(assistant);
    await record({
      role: "toolResult",
      toolCallId: block.id,
      name: block.name,
      text: LOOP_INTERRUPTED_TOOL_RESULT_TEXT,
    });
    keptCount += 2;
  }
  // G1：未关账半截 text 追加到尾批文本（与完成块同批记录，流序恒尾部）
  if (partialText !== undefined && partialText !== "") textParts.push(partialText);
  await flushText();
  if (pendingThinking !== undefined) {
    dropped.push({
      kind: "thinking",
      reason: "尾部悬挂（无后继内容块——thinking 单独回传非法）",
      summary: pendingThinking.text.slice(0, 80),
    });
  }
  await record({ role: "user", text: LOOP_INTERRUPTED_MARKER_TEXT });
  return keptCount === 0 && dropped.length === 0 ? undefined : { keptMessages: keptCount, droppedBlocks: dropped };
}
