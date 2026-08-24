import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import { LEGACY_MAIN_INSTANCE_ID } from "../../../../domain/agent/AgentInstance";
import type { EntryData } from "../../../../domain/session/Entry";
import type { AgentEngineUsage } from "../../../../application/ports/outbound/AgentEnginePort";

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

/** pi 消息 → 纯文本。 */
export function textOfMessage(message: AgentMessage): string {
  const m = message as { role: string; content: unknown };
  switch (m.role) {
    case "user":
    case "assistant":
      return textOfContent(m.content);
    case "toolResult":
      return textOfContent(m.content);
    default:
      return "";
  }
}

/** 构造 pi 用户消息（steer 注入 / prompt 驱动共用）。 */
export function userMessage(text: string): UserMessage {
  return { role: "user", content: text, timestamp: Date.now() };
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

/** pi Usage → 七字段防腐（提取本体轻量，账目本体归 UsageLedger）。
 *  cost 拍平取 total；reasoning 未报时 0。消息不携带 usage → undefined。 */
export function usageOf(message: AgentMessage): AgentEngineUsage | undefined {
  const usage = (message as { usage?: Usage }).usage;
  if (usage === undefined) return undefined;
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

/** pi 消息 → domain Entry 数据形状（工具结果归 tool；custom 消息忽略）。
 *  实例归属恒为主实例（pi-engine 映射的是主会话引擎流；SubAgent 侧
 * 映射归子进程 adapter）。本文件供引擎事件侧薄映射；完整 Entry
 * 树映射归持久化适配器。 */
export function entryDataOf(message: AgentMessage, fallbackTurnId: string | null): EntryData | null {
  const m = message as { role: string; content: unknown };
  if (m.role === "user") {
    return {
      id: "",
      role: "user",
      text: textOfContent(m.content),
      turnId: fallbackTurnId,
      isSteer: false,
      instanceId: LEGACY_MAIN_INSTANCE_ID,
      createdAt: new Date().toISOString(),
    };
  }
  if (m.role === "assistant") {
    return {
      id: "",
      role: "assistant",
      text: textOfContent(m.content),
      turnId: fallbackTurnId,
      isSteer: false,
      instanceId: LEGACY_MAIN_INSTANCE_ID,
      createdAt: new Date().toISOString(),
    };
  }
  return null;
}
