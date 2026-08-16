import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { MAIN_INSTANCE_ID } from "../../../../domain/agent/AgentInstance";
import type { EntryData } from "../../../../domain/session/Entry";

/**
 * SessionMapper —— pi 消息 ↔ domain 聚合的薄映射（architecture.md §3.5/§5.5）。
 *
 * 防腐原则（AD-16）：pi 的消息类型只进 pi-engine 目录，domain 不见 pi
 * 类型；映射层刻意薄——本任务只需文本抽取（引擎事件翻译）与用户消息
 * 构造（steer/prompt 注入），Entry 树/LaneRecord 的完整持久化映射随
 * T1.8（SQLite 落盘）扩展。
 */

/** 内容块 → 纯文本（text 块拼接；toolCall 块贡献空串——TS3-a：工具轮
 *  占位文本不产生，toolCall-only 消息经空文本守卫不落账；其余非 text
 *  块类型以占位标记，行为不变）。 */
export function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: { type?: string; text?: string }) => {
        if (block?.type === "text") return block.text ?? "";
        if (block?.type === "toolCall") return "";
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

/** pi 消息 → domain Entry 数据形状（工具结果归 tool；custom 消息忽略）。
 *  实例归属恒为主实例（pi-engine 映射的是主会话引擎流；SubAgent 侧
 *  映射归 T2.x 子进程 adapter）。本任务供引擎事件侧薄映射；完整 Entry
 *  树映射 T1.8 扩展。 */
export function entryDataOf(message: AgentMessage, fallbackTurnId: string | null): EntryData | null {
  const m = message as { role: string; content: unknown };
  if (m.role === "user") {
    return {
      id: "",
      role: "user",
      text: textOfContent(m.content),
      turnId: fallbackTurnId,
      isSteer: false,
      instanceId: MAIN_INSTANCE_ID,
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
      instanceId: MAIN_INSTANCE_ID,
      createdAt: new Date().toISOString(),
    };
  }
  return null;
}
