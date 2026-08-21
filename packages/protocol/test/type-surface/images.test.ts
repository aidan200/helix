/**
 * v0.10 图片上下行 additive 断言（T9）：
 * - ChatSendPayload.images（上行：用户发图给 LLM，≤4 张 data URL）；
 * - MessageEntryDto.images（下行：user 消息气泡缩略图）；
 * - ToolCallEntryDto.images（下行：工具结果附带截图）；
 * - 版本位 0.10 + 样例帧可构造窄化。
 * 全链 base64 data URL（设计裁决）；三字段全可选 additive（旧客户端零破坏）。
 */
import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "../../src/index";
import type { ChatSendPayload, MessageEntryDto, ToolCallEntryDto } from "../../src/index";
import type { Equal, Expect } from "./samples/helpers";
import { dispatchCommand, summarizeEvent } from "./samples/helpers";
import { chatSendWithImages, messageCompletedUserImages, toolCallResultImages, TINY_PNG_DATA_URL } from "./samples/v010";

// ── 类型级断言（编译期；任一不满足 → tsc --noEmit 失败） ──

// images 可选（undefined 合法；additive 纪律——缺省 = 不带图旧形态）
type _ChatSendImages = Expect<Equal<ChatSendPayload["images"], readonly string[] | undefined>>;
type _MessageImages = Expect<Equal<MessageEntryDto["images"], readonly string[] | undefined>>;
type _ToolCallImages = Expect<Equal<ToolCallEntryDto["images"], readonly string[] | undefined>>;

// 版本位单值（批次集合标记）
type _ProtocolVersionV010 = Expect<Equal<typeof PROTOCOL_VERSION, "0.10">>;

describe("v0.10：图片上下行 additive（T9）", () => {
  test("版本位 0.9 → 0.10（envelope 单点；批次标记非协商位）", () => {
    expect(PROTOCOL_VERSION).toBe("0.10");
    expect(chatSendWithImages.v).toBe("0.10");
    expect(messageCompletedUserImages.v).toBe("0.10");
  });

  test("chat.send.images 上行：载荷透传 data URL 数组（dispatch 窄化消费）", () => {
    expect(chatSendWithImages.payload.images).toEqual([TINY_PNG_DATA_URL]);
    expect(dispatchCommand(chatSendWithImages)).toBe("send:看看这张截图");
    // 缺省形态（不带 images）仍合法：additive 纪律
    const legacy: ChatSendPayload = { text: "纯文本" };
    expect(legacy.images).toBeUndefined();
  });

  test("MessageEntryDto.images 下行：user 消息携带缩略图数据", () => {
    const entry = messageCompletedUserImages.payload.entry;
    if (entry.kind !== "message") throw new Error("样例应为 message 变体");
    expect(entry.images).toEqual([TINY_PNG_DATA_URL]);
    expect(summarizeEvent(messageCompletedUserImages)).toBe("msg:e5");
    // assistant 消息不产图：字段可选缺省
    const assistant: MessageEntryDto = {
      kind: "message",
      id: "e7",
      role: "assistant",
      content: "分析完成",
      ts: 1755000001000,
    };
    expect(assistant.images).toBeUndefined();
  });

  test("ToolCallEntryDto.images 下行：工具结果附带截图", () => {
    const entry = toolCallResultImages.payload.entry;
    if (entry.kind !== "tool-call") throw new Error("样例应为 tool-call 变体");
    expect(entry.images).toEqual([TINY_PNG_DATA_URL]);
    expect(summarizeEvent(toolCallResultImages)).toBe("tool-result:e6");
    // 无图工具结果仍合法（字段可选）
    const plain: ToolCallEntryDto = {
      kind: "tool-call",
      id: "e8",
      name: "grep",
      args: "{}",
      result: "0 hits",
      state: "done",
      ts: 1755000002000,
    };
    expect(plain.images).toBeUndefined();
  });
});
