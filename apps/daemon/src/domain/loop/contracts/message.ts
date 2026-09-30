/**
 * contracts/message —— loop 域消息契约（helix-loop Phase 0a 四层拆分；
 * Phase 1 块模型演进：assistant 从「text?/thinking?/toolCall? 三可选字段」
 * 改为 content 块数组——对齐 pi AssistantMessage.content 的结构形态
 * （text/thinking/toolCall/image 块混排），单 toolCall 与多 toolCall（Phase 3
 * 批执行）从此是同一形状的 1 与 N。设计锚 docs/temp/helix-loop-foundation-
 * design.md §3.1。
 *
 * 命名约定：块判别字段 = type（与 pi ContentBlock 同名）；字段名沿用 domain
 * 词典（thinking 块载荷 text/signature、toolCall 块参数 args——翻译面
 * adapters/driven/loop 单点映射 pi 的 thinking/thinkingSignature/arguments）。
 */

/** 图片载荷（上行/下行同形——pi ImageContent 同构载荷；Phase 1 只落类型
 *  形状，图片上行接线与处理逻辑是后续 Phase，本批无消费面）。 */
export interface LoopImage {
  /** base64 数据（不含 data: 前缀）。 */
  readonly data: string;
  readonly mimeType: string;
}

/** assistant 内容块（判别联合——块序即流序，provider 语义面 thinking 块
 *  先于 text/toolCall；与 pi AssistantMessage.content 结构同构）。
 *  - text：文本段；
 *  - thinking：推理块（signature = provider 不透明回传凭据——Anthropic 式
 *    最严约束：多轮 thinking 块须携签名回传）；
 *  - toolCall：工具调用块（Phase 1 语义 N=1——kernel 取首枚执行，多枚见
 *    LoopKernel 分流注释；Phase 3 批执行接手）；
 *  - image：图片块（Phase 1 只落类型形状——adapter 不产此块帧，处理逻辑
 *    后续 Phase）。 */
export type LoopContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly text: string; readonly signature?: string }
  | {
      readonly type: "toolCall";
      readonly id: string;
      readonly name: string;
      readonly args: Record<string, unknown>;
    }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

/** 块集内 text 块拼接（终答投影——终答可能多 text 块，拼接即全文）。 */
export function loopBlocksText(blocks: readonly LoopContentBlock[]): string {
  let out = "";
  for (const b of blocks) {
    if (b.type === "text") out += b.text;
  }
  return out;
}

/** 块集内首枚 toolCall 块（Phase 1 单枚语义提取面；缺席 = 纯文本轮）。 */
export function firstToolCallBlock(blocks: readonly LoopContentBlock[]): LoopContentBlock & { type: "toolCall" } | undefined {
  for (const b of blocks) {
    if (b.type === "toolCall") return b;
  }
  return undefined;
}

/** 对话消息（loop 域窄面；与 application 的 StewardLlmMessage 结构同构——
 *  TS 结构类型直接互通，driven 编译锚锁定形状）。 */
export type LoopMessage =
  | {
      readonly role: "user";
      readonly text: string;
      /** L1 件一：压缩摘要合成消息标记（synthesized——非用户真实输入；
       *  回传面与普通 user 同构，标记仅供 UI/追踪区分）。 */
      readonly compaction?: true;
      /** 图片上行（Phase 1 只落类型形状——A2 多模态位；处理逻辑后续 Phase）。 */
      readonly images?: readonly LoopImage[];
    }
  | {
      readonly role: "assistant";
      /** 内容块数组（Phase 1 块模型——text/thinking/toolCall/image 混排，
       *  块序即流序）。 */
      readonly content: readonly LoopContentBlock[];
    }
  | {
      readonly role: "toolResult";
      readonly toolCallId: string;
      readonly name: string;
      readonly text: string;
      /** 图片下行（Phase 1 只落类型形状；处理逻辑后续 Phase）。 */
      readonly images?: readonly LoopImage[];
      /** 工具执行 token 账目（Phase 1 只落类型形状——Phase 4 工具桥接线
       *  UsageLedger 时产出；本批无生产/消费面）。 */
      readonly usage?: LoopUsage;
    };

/** 工具执行 token 账目（pi Usage 的 domain 窄面——Phase 4 工具桥扩展
 *  cache/cost 位时再评估；本批只落形状）。 */
export interface LoopUsage {
  readonly input: number;
  readonly output: number;
  readonly totalTokens: number;
}

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
