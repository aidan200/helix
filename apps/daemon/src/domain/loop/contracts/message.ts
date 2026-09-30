/**
 * contracts/message —— loop 域消息契约（helix-loop Phase 0a 四层拆分；
 * 原 LoopTypes.ts 按主题拆六件之一，设计 §2.1）。
 *
 * LoopMessage 三角色纯文本形状（Phase 1 块模型演进位）；与 application 的
 * StewardLlmMessage 结构同构（TS 结构类型直接互通）。
 */
/** thinking 块（全精度：文本 + provider 回传凭据）。 */
export interface LoopThinking {
  readonly text: string;
  readonly signature?: string;
}

/** 对话消息（loop 域窄面；与 StewardLlmMessage 同构）。 */
export type LoopMessage =
  | {
      readonly role: "user";
      readonly text: string;
      /** L1 件一：压缩摘要合成消息标记（synthesized——非用户真实输入；
       *  回传面与普通 user 同构，标记仅供 UI/追踪区分）。 */
      readonly compaction?: true;
    }
  | {
      readonly role: "assistant";
      readonly text?: string;
      readonly thinking?: LoopThinking;
      readonly toolCall?: { readonly id: string; readonly name: string; readonly args: Record<string, unknown> };
    }
  | { readonly role: "toolResult"; readonly toolCallId: string; readonly name: string; readonly text: string };

/** run 内新消息持久化回调（调用方工作记忆/事件存储同步——await 串行保序）。 */
export type LoopMessageSink = (message: LoopMessage) => Promise<void>;

/** 压缩完成回调信息（调用方事实源同步面——管家工作记忆 KV 整窗替换）。
 *  归 contracts 消息件：本质是消息窗口替换的投影（摘要合成消息 + 保留区
 *  原文），kernel 的 LoopRunInput.onCompacted 与 policy 压缩步共用本形状。 */
export interface LoopCompactionInfo {
  /** 摘要合成消息（compaction: true——入事实源的形态）。 */
  readonly summaryMessage: LoopMessage & { role: "user"; compaction: true };
  /** 保留区消息（滚动窗原文）。 */
  readonly keptMessages: readonly LoopMessage[];
  /** 被压缩抆的历史消息条数。 */
  readonly droppedCount: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}
