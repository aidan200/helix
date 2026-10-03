/**
 * StewardLlmMessages —— pi Message[] ↔ StewardLlmMessage[] 转换（段B翻转批）。
 *
 * driven/steward 防腐墙内的共享转换件：压缩摘要 override（AgentMessage →
 * port 消息）与测试剧本通道（port 脚本 → streamFn）共用。系统消息丢弃
 * （systemPrompt 经 port 请求字段直传）；assistant thinking 块异名双射
 * （pi thinking ↔ port text）；toolCall arguments↔args。
 */
import type { Message } from "@earendil-works/pi-ai";
import type { StewardLlmContentBlock, StewardLlmMessage } from "../../../application/ports/outbound/StewardLlmPort";
import { ZERO_USAGE } from "../pi-engine/mappers/SessionMapper";

export function piMessagesToSteward(messages: readonly Message[]): StewardLlmMessage[] {
  const out: StewardLlmMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      out.push({ role: "user", text: textOfContents(m.content) });
    } else if (m.role === "assistant") {
      out.push({ role: "assistant", content: (m.content as readonly unknown[]).map(piBlockToSteward) });
    } else {
      const tr = m as { toolCallId: string; toolName: string; content: readonly unknown[] };
      out.push({ role: "toolResult", toolCallId: tr.toolCallId, name: tr.toolName, text: textOfContents(tr.content) });
    }
  }
  return out;
}

function textOfContents(content: readonly unknown[] | string): string {
  if (typeof content === "string") return content;
  return content
    .filter((c): c is { type: "text"; text: string } => (c as { type: string }).type === "text")
    .map((c) => c.text)
    .join("");
}

function piBlockToSteward(block: unknown): StewardLlmContentBlock {
  const b = block as Record<string, unknown>;
  if (b.type === "text") return { type: "text", text: String(b.text ?? "") };
  if (b.type === "thinking") {
    return { type: "thinking", text: String(b.thinking ?? ""), ...(b.signature !== undefined ? { signature: String(b.signature) } : {}) };
  }
  if (b.type === "toolCall") {
    return { type: "toolCall", id: String(b.id), name: String(b.name), args: (b.arguments ?? {}) as Record<string, unknown> };
  }
  if (b.type === "image") return { type: "image", data: String(b.data ?? ""), mimeType: String(b.mimeType ?? "") };
  return { type: "text", text: JSON.stringify(b) };
}

/** StewardLlmMessage[] → pi AgentMessage[]（反向转换——引擎构造 initialMessages
 *  回填面：dialog 懒加载快照（port 形状）→ pi transcript 初值）。 */
export function stewardMessagesToPi(messages: readonly StewardLlmMessage[]): import("@earendil-works/pi-agent-core").AgentMessage[] {
  const out: import("@earendil-works/pi-agent-core").AgentMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.text, timestamp: Date.now() } as never);
    } else if (m.role === "assistant") {
      // 回填 assistant 必带零值 usage（pi-ai 1.0.0 estimate 无判空直读
      // usage.totalTokens——缺字段在请求构造期 maxTokens 鉗制路径抛 TypeError；
      // 防回归锚 test/unit/steward-llm-messages.test.ts）。
      out.push({
        role: "assistant",
        content: m.content.map((b) => {
          if (b.type === "text") return { type: "text" as const, text: b.text };
          if (b.type === "thinking") {
            return { type: "thinking" as const, thinking: b.text, ...(b.signature !== undefined ? { signature: b.signature } : {}) };
          }
          if (b.type === "toolCall") {
            return { type: "toolCall" as const, id: b.id, name: b.name, arguments: b.args as never };
          }
          return { type: "text" as const, text: "(image 块不支持回填)" };
        }),
        api: "anthropic-messages",
        provider: "fake",
        model: "model",
        stopReason: "stop",
        usage: ZERO_USAGE,
        timestamp: Date.now(),
      } as never);
    } else {
      out.push({
        role: "toolResult",
        toolCallId: m.toolCallId,
        toolName: m.name,
        content: [{ type: "text" as const, text: m.text }],
        timestamp: Date.now(),
      } as never);
    }
  }
  return out;
}
