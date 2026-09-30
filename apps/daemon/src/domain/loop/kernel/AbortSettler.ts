/**
 * kernel/AbortSettler —— E-198 打断善后内核（helix-loop Phase 0a 四层拆分；
 * 设计 §2.2：原 LoopEngine.settleAbortedTurn 独立成件——依赖注入
 * recordMessage，独立可测；Phase 1 块模型迁移：安全块集作为单条 assistant
 * content 入账（块序即流序——旧「thinking 归属切分多条消息」消失：一条
 * 消息装全部块，I4 连续 assistant 归并风险随之消失）。
 *
 * E-198 打断善后内核（§2.1 partial 保留）：安全块入账 + 截断标记 + 不安全块丢弃。
 *  - 完整性唯一凭证 = 块 end（I1）：入参 blocks 只含已收 end 的块；
 *  - G1（duplex-truncation §3.3 text 行定稿）：未关账半截 text 经 partialText
 *    追加为 content 尾部独立 text 块（与安全块同批——单条 assistant 记录，
 *    流序恒尾部）——文本无配对/签名约束全 provider 安全，模型须记得被掐断
 *    的已播半句（P2）；partialText 缺席/空 = 无半截 text，行为与 G1 前完全
 *    一致；partialText 只含未关账增量（adapter 保证不含已关账块，防重复
 *    入账）；
 *  - 半截 thinking/toolCall（无 end）无帧不入账（I2）；策略丢弃（完成但不可
 *    回传）：无签名 thinking（pi 判例③）与尾部悬挂 thinking（无后继内容块
 *    ——单独回传 = "reasoning without following item" 类 provider 拒绝，pi
 *    判例①同族；G1 半截 text 追加后再判——半截 text 作为后继内容块可合法
 *    承接签名 thinking）→ audit 记录（I6）；
 *  - 完整 toolCall 块（已收 end 未执行——打断在流式段，工具段不打断 §6.2）
 *    保留在 content 中 + 合成中断 toolResult 配对（I3，pi 判例①同族）；
 *  - 截断标记（turn 级）永远落一枚：零安全块时也告知模型被掐（连续性），
 *    多次打断跨 run 各自累积不重复（T6）。
 */
import type { LoopAbortAudit, LoopAbortDroppedBlock, LoopContentBlock, LoopMessage } from "../contracts";
import { LOOP_INTERRUPTED_MARKER_TEXT, LOOP_INTERRUPTED_TOOL_RESULT_TEXT } from "../contracts/markers";

/** E-198 打断善后（转录入账经注入的 record 单写者——与 kernel recordMessage
 *  同序：push 窗口 + onNewMessage 串行保序）。 */
export async function settleAbortedTurn(
  record: (message: LoopMessage) => Promise<void>,
  blocks: readonly LoopContentBlock[],
  partialText?: string,
): Promise<LoopAbortAudit | undefined> {
  const dropped: LoopAbortDroppedBlock[] = [];
  // 1. 无签名 thinking 丢弃（I2——pi 判例③：不可回传）
  const kept: LoopContentBlock[] = [];
  for (const block of blocks) {
    if (block.type === "thinking" && (block.signature === undefined || block.signature === "")) {
      dropped.push({ kind: "thinking", reason: "无签名不可回传（pi 判例③）", summary: block.text.slice(0, 80) });
      continue;
    }
    kept.push(block);
  }
  // 2. G1：半截 text（partialText）追加为尾部独立 text 块——与安全块同批
  //    入账（流序恒尾部；先追加再剥悬挂：半截 text 可合法承接签名 thinking）
  if (partialText !== undefined && partialText !== "") kept.push({ type: "text", text: partialText });
  // 3. 尾部悬挂 thinking 剥离（无后继内容块——单独回传非法）
  while (kept.length > 0 && kept[kept.length - 1]!.type === "thinking") {
    const tail = kept.pop() as LoopContentBlock & { type: "thinking" };
    dropped.push({
      kind: "thinking",
      reason: "尾部悬挂（无后继内容块——thinking 单独回传非法）",
      summary: tail.text.slice(0, 80),
    });
  }
  // 4. 安全块集非空 → 单条 assistant content 入账（块序即流序）
  let keptMessages = 0;
  if (kept.length > 0) {
    await record({ role: "assistant", content: kept });
    keptMessages += 1;
  }
  // 5. I3：content 内完整 toolCall 块（未执行）→ 合成中断 toolResult 配对
  for (const block of kept) {
    if (block.type !== "toolCall") continue;
    await record({
      role: "toolResult",
      toolCallId: block.id,
      name: block.name,
      text: LOOP_INTERRUPTED_TOOL_RESULT_TEXT,
    });
    keptMessages += 1;
  }
  // 6. 截断标记（零安全块也落——模型知道被掐）
  await record({ role: "user", text: LOOP_INTERRUPTED_MARKER_TEXT });
  return keptMessages === 0 && dropped.length === 0 ? undefined : { keptMessages, droppedBlocks: dropped };
}
