import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, TextContent, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { abortShapingConvertToLlm } from "../../src/adapters/driven/pi-engine/AbortShaping";
import { LOOP_INTERRUPTED_MARKER_TEXT } from "../../src/domain/loop/contracts/markers";
import { convertToLlm as baseConvertToLlm } from "../../src/adapters/driven/tools/vendor/pi-harness";

function user(text: string): UserMessage {
  return { role: "user", content: text, timestamp: 1 };
}

function abortedAssistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses" as never,
    provider: "mock",
    model: "mock",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "aborted",
    timestamp: 2,
  };
}

function toolResult(toolCallId: string, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "t",
    content: [{ type: "text", text }],
    isError: false,
    usage: undefined,
    timestamp: 3,
  };
}

const text = (t: string): TextContent => ({ type: "text", text: t });

/** 修形层单测：E-198 判据的 pi-AgentMessage 形状（升级批次 3）。 */
describe("AbortShaping（pi 通道打断善后修形层）", () => {
  const shape = (messages: AgentMessage[]): Message[] =>
    abortShapingConvertToLlm(baseConvertToLlm)(messages) as Message[];

  test("① aborted assistant（text 完整+thinking+toolCall）→ user 修形：text 保留+标记；thinking/toolCall 剔除", () => {
    const out = shape([
      user("问题"),
      abortedAssistant([
        text("已经说了一半的话"),
        { type: "thinking", text: "推理链半截…", signature: undefined } as never,
        { type: "toolCall", id: "tc-1", name: "danger", arguments: { a: 1 } } as never,
      ]),
    ]);
    // 产物：原 user + 修形 user（prefix + text + 标记）——thinking/toolCall 无踪
    expect(out).toHaveLength(2);
    const shaped = out[1] as UserMessage;
    expect(shaped.role).toBe("user");
    const shapedText = Array.isArray(shaped.content)
      ? shaped.content.filter((c): c is TextContent => c.type === "text").map((c) => c.text).join("\n")
      : shaped.content;
    expect(shapedText).toContain("已经说了一半的话");
    expect(shapedText).toContain(LOOP_INTERRUPTED_MARKER_TEXT);
    expect(shapedText).not.toContain("推理链半截");
  });

  test("② 被剔 toolCall 的孤儿 toolResult 剔除（I1 配对）；无关 toolResult 保留", () => {
    const out = shape([
      user("go"),
      abortedAssistant([
        { type: "toolCall", id: "tc-abort", name: "a", arguments: {} } as never,
      ]),
      toolResult("tc-abort", "Operation aborted"),
      toolResult("tc-live", "正常结果"),
    ]);
    const texts = out.map((m) => (m.role === "toolResult" ? (m as ToolResultMessage).toolCallId : m.role));
    // 修形 user（含标记）替身 aborted assistant；tc-abort 孤儿剔除；tc-live 保留
    expect(texts).toContain("tc-live");
    expect(texts).not.toContain("tc-abort");
    expect(out.some((m) => m.role === "assistant")).toBe(false);
  });

  test("③ 全空 aborted（无任何块）→ 仅标记 user 消息（模型仍知被打断）", () => {
    const out = shape([user("q"), abortedAssistant([])]);
    expect(out).toHaveLength(2);
    const shaped = out[1] as UserMessage;
    const shapedText = Array.isArray(shaped.content) ? JSON.stringify(shaped.content) : shaped.content;
    expect(shapedText).toContain(LOOP_INTERRUPTED_MARKER_TEXT);
  });

  test("④ 正常流零改动（无 aborted 消息时逐条对照透传）", () => {
    const normal: AgentMessage[] = [
      user("hi"),
      { ...abortedAssistant([text("ok")]), stopReason: "stop" } as AssistantMessage,
      toolResult("tc-x", "r"),
    ];
    const out = shape(normal);
    expect(out).toEqual(baseConvertToLlm(normal));
  });

  test("⑤ compactionSummary 共存：内层转换仍生效（→ user 前缀消息）", () => {
    const out = shape([
      { role: "compactionSummary", summary: "压缩摘要", tokensBefore: 100, timestamp: 1 } as never,
      user("继续"),
    ]);
    // 内层 baseConvertToLlm 把 compactionSummary 转 user（前缀含 summary 文本）
    expect(out).toHaveLength(2);
    const first = out[0] as UserMessage;
    const firstText = Array.isArray(first.content) ? JSON.stringify(first.content) : first.content;
    expect(firstText).toContain("压缩摘要");
  });

  test("⑥ 丢弃审计回调：thinking/toolCall 丢弃留痕（I6 审计面）", () => {
    const dropped: string[] = [];
    const conv = abortShapingConvertToLlm(baseConvertToLlm, (block) => dropped.push(block.kind));
    conv([
      abortedAssistant([
        text("t"),
        { type: "thinking", text: "x" } as never,
        { type: "toolCall", id: "tc-1", name: "n", arguments: {} } as never,
      ]),
    ]);
    expect(dropped.sort()).toEqual(["thinking", "toolCall"]);
  });
});
