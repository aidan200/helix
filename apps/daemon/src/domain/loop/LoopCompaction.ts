/**
 * LoopCompaction —— helix-loop L1 件一（上下文压缩）纯函数面
 * （docs/temp/helix-loop-design.md §5 compaction 行 / §6 L1 批）。
 *
 * 能力形态：loop 域能力（非管家专用）——阈值判定 + 压缩区间规划 +
 * 配对保护（duplex-truncation I5 同族：压缩不得切断 toolCall/toolResult
 * 配对——保留区头不得是孤儿 toolResult，同 trimToBudget /
 * dropHeadOrphanToolResults 的配对感知口径）。摘要执行体（LLM 调用）由
 * 调用方注入（LoopCompactionOptions.summarize）——domain 零外部依赖。
 *
 * TR-47 语义对齐：压的是历史不是工作集——尾部 keepRecent 条原文滚动保留。
 * 与主会话面 CompactionHook（pi prepareNextTurn 挂点）的差异：管家单 run
 * 首轮 = 对话继续（工作记忆跨 run 持久），故首轮前同查（否则首请求携超窗
 * 载荷直达 provider）；纯问答轮后窗口超阈由下次 ask 首轮前压缩接住，
 * 16k 粗裁剪（StewardDialogMemory）保留为压缩失败/不可压区间的兑底。
 */
import type { LoopMessage } from "./LoopTypes";

/** token 估算（与 StewardDialogMemory.estimateTokens 同族口径：chars/2 保守
 *  近似 + 每条 8 形状开销——宁可早压不可爆上下文）。 */
export function estimateLoopTokens(messages: readonly LoopMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (m.role === "user") chars += m.text.length;
    else if (m.role === "toolResult") chars += m.text.length + m.name.length;
    else {
      chars += (m.text ?? "").length + (m.thinking?.text.length ?? 0) + (m.thinking?.signature?.length ?? 0);
      if (m.toolCall !== undefined) {
        chars += m.toolCall.name.length + JSON.stringify(m.toolCall.args).length;
      }
    }
  }
  return Math.ceil(chars / 2) + messages.length * 8;
}

/** 压缩区间规划产物：[0, compactFrom) 被压缩为摘要，[compactFrom, len) 保留原文。 */
export interface LoopCompactionPlan {
  readonly compactFrom: number;
}

/**
 * 压缩窗口规划（纯函数；阈值内/无可压区间 → null 不触发）：
 * 1. 初始边界 = 尾部 keepRecent 条之前（TR-47 滚动窗）；
 * 2. 配对保护（I5 同族）：保留区头若是孤儿 toolResult（配对 assistant
 *    toolCall 落在压缩区）→ 边界左移把它纳入压缩区（摘要会吸收其结论），
 *    直到保留区头非孤儿——压缩后窗口不得携带孤儿（A1-hotfix 400 教训的
 *    压缩面：孤儿直达 provider = "tool_call_id is not found"）；
 * 3. 全量落在保留窗（超窗但无可压区间，如单条巨长消息）→ null——
 *    交由调用方粗裁剪兑底（记录本身不可截断）。
 */
export function planCompactionWindow(
  messages: readonly LoopMessage[],
  opts: { thresholdTokens: number; keepRecent: number },
): LoopCompactionPlan | null {
  const total = estimateLoopTokens(messages);
  if (total <= opts.thresholdTokens) return null;
  const len = messages.length;
  let compactFrom = Math.max(0, len - opts.keepRecent);
  if (compactFrom === 0) return null; // 无可压区间（全在滚动窗内）
  const callIds = new Set<string>();
  for (let i = compactFrom; i < len; i += 1) {
    const m = messages[i]!;
    if (m.role === "assistant" && m.toolCall !== undefined) callIds.add(m.toolCall.id);
  }
  while (compactFrom > 0) {
    const m = messages[compactFrom]!;
    if (m.role !== "toolResult" || callIds.has(m.toolCallId)) break;
    compactFrom -= 1; // 保留区头孤儿：纳入压缩区（压掉）
  }
  if (compactFrom === 0) return null; // 防御：压缩区空（连续孤儿吞尽全窗）
  return { compactFrom };
}

/** 压缩摘要 system prompt（任务书要点：保留任务上下文/用户偏好/未完结话题，
 *  丢弃工具结果原文只留结论，输出压缩后摘要消息）。 */
export const LOOP_COMPACTION_SUMMARY_PROMPT = `你是 helix 管家的上下文压缩器。把给定的历史对话压缩为一段摘要，供后续对话作为最早的上下文使用。

要求：
- 保留：任务上下文（用户在做什么/关注什么）、用户偏好与明确指示、未完结的话题与待办、工具调用已得出的结论；
- 丢弃：工具结果的原文细节（只留结论一行）、寒暄与重复表述、已完结且无后续引用价值的轮次；
- 输出：一段紧凑的中文摘要（不用列表头、不用客套话，直接陈述事实与状态），长度不超过 300 字。`;
