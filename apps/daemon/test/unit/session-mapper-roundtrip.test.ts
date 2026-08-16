import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { entryDataOf, textOfContent, textOfMessage, userMessage } from "../../src/adapters/driven/pi-engine/mappers/SessionMapper";
import type { EntryData } from "../../src/domain/session/Entry";

/**
 * TP-CL8-4：薄防腐映射往返——domain Entry 形态 → pi 消息形态 → domain，
 * 语义等价（domain 不 import pi 类型由 AG-04 兜底扫描）。
 * 本任务经 SessionRepository 直存 domain 聚合（pi-session-backend 不引入，
 * 架构 §5.5），SessionMapper 的 pi 侧映射保持 T1.4 现状，往返面以现有
 * user/assistant 文本映射为口径。
 */
describe("TP-CL8-4：SessionMapper 往返 roundtrip", () => {
  test("user EntryData → pi UserMessage → EntryData 语义等价", () => {
    const data: EntryData = {
      id: "e1",
      role: "user",
      text: "帮我写一段介绍",
      turnId: "t1",
      isSteer: false,
      instanceId: "main",
      createdAt: "2024-01-01T00:00:01.000Z",
    };
    const msg = userMessage(data.text);
    const back = entryDataOf(msg, data.turnId)!;
    expect(back.role).toBe("user");
    expect(back.text).toBe(data.text); // 语义核心：文本无损
    expect(back.turnId).toBe(data.turnId);
    expect(textOfMessage(msg)).toBe(data.text);
  });

  test("assistant 内容块 → 纯文本 → EntryData 语义等价", () => {
    const assistant = {
      role: "assistant",
      content: [
        { type: "text", text: "第一段。" },
        { type: "text", text: "第二段。" },
      ],
    } as unknown as AgentMessage;
    const back = entryDataOf(assistant, "t1")!;
    expect(back.role).toBe("assistant");
    expect(back.text).toBe("第一段。第二段。");
    expect(textOfContent([{ type: "text", text: "abc" }])).toBe("abc");
  });

  test("工具结果内容（字符串/块）文本抽取稳定（toolResult 归 tool 语义）", () => {
    const toolResult = { role: "toolResult", content: "工具输出文本" } as unknown as AgentMessage;
    expect(textOfMessage(toolResult)).toBe("工具输出文本");
  });
});

describe("TS3-a：textOfContent 的 toolCall 块贡献空串", () => {
  test("纯 text 块拼接；string 内容直通", () => {
    expect(textOfContent([{ type: "text", text: "甲" }, { type: "text", text: "乙" }])).toBe("甲乙");
    expect(textOfContent("直接字符串")).toBe("直接字符串");
  });

  test("toolCall-only → 空串（占位文本不产生，经空文本守卫不落 Entry）", () => {
    expect(textOfContent([{ type: "toolCall", name: "bash" }])).toBe("");
    expect(
      textOfMessage({
        role: "assistant",
        content: [
          { type: "toolCall", name: "grep", arguments: { q: "x" } },
          { type: "toolCall", name: "bash" },
        ],
      } as unknown as AgentMessage),
    ).toBe("");
  });

  test("text+toolCall 混合 → 仅 text", () => {
    expect(
      textOfContent([
        { type: "text", text: "先说结论。" },
        { type: "toolCall", name: "grep" },
        { type: "text", text: "补充。" },
      ]),
    ).toBe("先说结论。补充。");
  });

  test("thinking 块贡献空串（T3.1 一等通道化：独立 Entry，不再占位污染正文）；未知块 [type] 占位保持", () => {
    expect(textOfContent([{ type: "thinking", thinking: "思考" }])).toBe("");
    expect(textOfContent([{}])).toBe("[unknown]");
  });
});
