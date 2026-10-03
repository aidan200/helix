import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent, Usage, UserMessage } from "@earendil-works/pi-ai";
import type { EntryData } from "../../../../domain/session/Entry";
import type { SessionEntryData } from "../../../../domain/session/SessionSnapshot";
import type { AgentEngineUsage } from "../../../../application/ports/outbound/AgentEnginePort";
import { parseDataUrlImages } from "../../../../application/services/images";

// 防腐墙出口：pi 消息类型经本映射层 re-export 给外层（infrastructure 装配）
// 作 type-only 消费——外层不得直接 import @earendil-works/pi-*（AG-04）。
export type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * SessionMapper —— pi 消息 ↔ domain 聚合的薄映射（architecture.md §3.5/§5.5）。
 *
 * 防腐原则（AD-16）：pi 的消息类型只进 pi-engine 目录，domain 不见 pi
 * 类型；映射层刻意薄——本任务只需文本抽取（引擎事件翻译）与用户消息
 * 构造（steer/prompt 注入），Entry 树/LaneRecord 的完整持久化映射随
 * 完整持久化映射由 sqlite-session 适配器承载。
 */

/** 内容块 → 纯文本（text 块拼接；toolCall/thinking 块贡献空串——
 * 工具轮占位文本不产生；thinking 为一等通道（独立 Entry），
 *  不再以占位标记污染消息正文；其余非 text 块类型以占位标记）。 */
export function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: { type?: string; text?: string }) => {
        if (block?.type === "text") return block.text ?? "";
        if (block?.type === "toolCall") return "";
        if (block?.type === "thinking") return "";
        return `[${block?.type ?? "unknown"}]`;
      })
      .join("");
  }
  return "";
}

/** pi 消息 → 纯文本（user/assistant/toolResult 三角色同体走 textOfContent；其余角色空串）。 */
export function textOfMessage(message: AgentMessage): string {
  const m = message as { role: string; content: unknown };
  return m.role === "user" || m.role === "assistant" || m.role === "toolResult" ? textOfContent(m.content) : "";
}

/** assistant 停止原因（abort/错误时 "error"|"aborted"）。 */
export function stopReasonOf(message: AgentMessage): string | undefined {
  return (message as AssistantMessage).stopReason;
}

/** assistant 错误描述（stopReason=error 时 pi 已归一化的 provider 原文，
 *  终验热修：错误透传链路的数据源——如 "429: {\"code\":\"1308\"…}"；
 *  无错误描述时回退通用文案）。 */
export function errorMessageOf(message: AgentMessage): string {
  const am = message as AssistantMessage;
  return typeof am.errorMessage === "string" && am.errorMessage.trim() !== ""
    ? am.errorMessage
    : "模型调用失败（provider 未返回错误详情）";
}

/** pi Usage → 七字段防腐映射单源（清单 #2.7：消息面（本文件 usageOf）与
 *  CompactionHook 摘要面共用——入参 Usage 本体，口径调整单点）。
 *  cost 拍平取 total；reasoning 未报时 0。 */
export function usageOfPi(usage: Usage): AgentEngineUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    reasoning: usage.reasoning ?? 0,
    totalTokens: usage.totalTokens,
    cost: usage.cost.total,
  };
}

/** pi Usage → 七字段防腐（提取本体轻量，账目本体归 UsageLedger）。
 *  cost 拍平取 total；reasoning 未报时 0。消息不携带 usage → undefined。 */
export function usageOf(message: AgentMessage): AgentEngineUsage | undefined {
  const usage = (message as { usage?: Usage }).usage;
  if (usage === undefined) return undefined;
  return usageOfPi(usage);
}

// ── 反向映射：Entry → pi AgentMessage（恢复回填） ─────────────────────

/** 回填 assistant 消息的模型元数据（历史消息以当前引擎模型补齐元数据）。 */
export interface SeedModelMeta {
  readonly api: string;
  readonly provider: string;
  readonly model: string;
}

/** 零值 usage（回填的历史 assistant 消息不携带真实计费——账目归 UsageLedger 事件流）。
 * 导出面：StewardLlmMessages（管家 dialog 回填）与 StewardEngineBuilder（压缩摘要
 * 覆写回包）同源引用——pi-ai 1.0.0 estimate.getLastAssistantUsageInfo 对
 * assistant.usage 无判空（calculateContextTokens 直读 usage.totalTokens），
 * 回填面缺 usage 即在请求构造期 maxTokens 鉗制路径抛 TypeError
 * （2026-10-03 管家全量「模型调用失败」事故；防回归锚见
 * test/unit/steward-llm-messages.test.ts）。 */
export const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * domain Entry → pi AgentMessage（恢复回填的单条映射）。
 * user（含图片）→ UserMessage；assistant → AssistantMessage（零 usage + stop）；
 * 其余角色（tool）→ null（工具中间态不回填——恢复是「重新开对话」非「续工具轮」）。
 * createdAt 解析失败（损坏行）→ null（防御跳过）。
 */
export function agentMessageOfEntry(entry: EntryData, meta: SeedModelMeta): AgentMessage | null {
  const timestamp = Date.parse(entry.createdAt);
  if (!Number.isFinite(timestamp)) return null;
  if (entry.role === "user") {
    const content: (TextContent | ImageContent)[] = [{ type: "text", text: entry.text }];
    if (entry.images !== undefined) {
      for (const url of entry.images) {
        try {
          const decoded = parseDataUrlImages([url])[0];
          if (decoded !== undefined) {
            content.push({ type: "image", mimeType: decoded.mimeType, data: decoded.data });
          }
        } catch {
          // 损坏图片防御：跳过该图（历史文本仍回填）
        }
      }
    }
    return { role: "user", content, timestamp } as UserMessage;
  }
  if (entry.role === "assistant") {
    return {
      role: "assistant",
      content: [{ type: "text", text: entry.text }],
      api: meta.api,
      provider: meta.provider,
      model: meta.model,
      usage: ZERO_USAGE,
      stopReason: "stop",
      timestamp,
    } as AssistantMessage;
  }
  return null; // tool（工具中间态）不回填
}

/**
 * 从会话条目派生 mainAgent 回填种子（恢复回填的入口纯函数）。
 * 只回填 instanceId === mainInstanceId 的 message 条目（user/assistant），
 * 按 Entry 树序（append 序）；thinking/compaction/SubAgent 条目跳过——
 * 与「会话聚合跨实例全历史 vs 实例窗口独立上下文」的三层模型对齐：
 * 每个 mainAgent 实例只回填它自己的对话历史，未来阶段切换新实例天然
 * 只回填自己的（新实例无历史 = 空 + 交接摘要）。
 */
export function seedMessagesOf(
  entries: readonly SessionEntryData[],
  mainInstanceId: string,
  meta: SeedModelMeta,
): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const entry of entries) {
    if (!("role" in entry)) continue; // thinking/compaction 不回填
    if (entry.instanceId !== mainInstanceId) continue; // 仅当前 mainAgent 实例
    const message = agentMessageOfEntry(entry, meta);
    if (message !== null) out.push(message);
  }
  return out;
}
