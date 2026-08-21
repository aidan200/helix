import { describe, expect, test } from "bun:test";
import { ChatService } from "../../src/application/services/ChatService";
import { SessionProjection } from "../../src/application/services/SessionProjection";
import type { EventPublisherPort, StreamDelta } from "../../src/application/ports/outbound/EventPublisherPort";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { InMemorySessionRepository } from "../mocks/InMemorySessionRepository";
import type { EntryData } from "../../src/domain/session/Entry";

/**
 * T9 图片上行（用户发图给 LLM）：
 * ① ChatService.sendMessage(text, images) → 引擎收到 ImageContent（数量/顺序/mimeType）；
 * ② user Entry / message.completed 载荷 / 投影快照全链携带 images（data URL）；
 * ③ 校验防护：数量 >4 / 坏格式 / 单张解码后 >2MB → 中文报错且不落消息不驱动引擎。
 */

/** 1×1 PNG 与 1×1 JPEG 的最小 base64 data URL（互异 mimeType 供顺序断言）。 */
export const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
export const TINY_JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

class RecordingPublisher implements EventPublisherPort {
  readonly domainEvents: DomainEvent[] = [];
  private readonly targets: EventPublisherPort[] = [];
  addTarget(target: EventPublisherPort): void {
    this.targets.push(target);
  }
  publish(event: DomainEvent): void {
    this.domainEvents.push(event);
    for (const t of this.targets) t.publish(event);
  }
  publishDelta(delta: StreamDelta): void {
    void delta;
  }
}

class FixedClock {
  private t = 0;
  now(): string {
    return new Date(0).toISOString();
  }
  nowMs(): number {
    return this.t++;
  }
}

function makeChat(engine: FakeAgentEngine) {
  const publisher = new RecordingPublisher();
  const repo = new InMemorySessionRepository();
  const chat = new ChatService({ engine, events: publisher, clock: new FixedClock() });
  const projection = new SessionProjection({
    repository: repo,
    getSession: () => chat.sessionView,
    getMainState: () => ({ agentState: chat.agentState, toolCalls: chat.toolCallData }),
  });
  publisher.addTarget(projection);
  return { chat, publisher, repo, projection };
}

describe("T9 图片上行：sendMessage 带图", () => {
  test("引擎收到 ImageContent（数量/顺序/mimeType/data）；Entry 与事件载荷携带 data URL", async () => {
    const engine = new FakeAgentEngine({ replies: [{ text: "已看到图。" }] });
    const { chat, publisher } = makeChat(engine);

    const outcome = await chat.sendMessage("看这两张图", [TINY_PNG, TINY_JPEG]);
    expect(outcome.mode).toBe("turn");

    // ① 引擎收到的 ImageContent（FakeAgentEngine capture，数量/顺序/mimeType）
    const captured = engine.lastPromptImages;
    if (captured === undefined) throw new Error("引擎未捕获到图片");
    expect(captured).toHaveLength(2);
    expect(captured[0]).toEqual({ type: "image", mimeType: "image/png", data: TINY_PNG.split(",")[1]! });
    expect(captured[1]).toEqual({ type: "image", mimeType: "image/jpeg", data: TINY_JPEG.split(",")[1]! });

    // ② user Entry 落聚合携带 images（data URL 原样）
    const userEntry = chat.sessionView.entryList().find((e): e is EntryData => "role" in e && e.role === "user");
    expect(userEntry?.images).toEqual([TINY_PNG, TINY_JPEG]);

    // ③ message.completed 领域事件载荷携带 images
    const completed = publisher.domainEvents.find((e) => e.type === "message.completed");
    expect((completed?.payload as { images?: string[] }).images).toEqual([TINY_PNG, TINY_JPEG]);
  });

  test("不带 images 旧行为零变更（captured 为 undefined、Entry 无 images 字段）", async () => {
    const engine = new FakeAgentEngine({ replies: [{ text: "纯文本。" }] });
    const { chat } = makeChat(engine);
    await chat.sendMessage("纯文本");
    expect(engine.lastPromptImages).toBeUndefined();
    const userEntry = chat.sessionView.entryList().find((e): e is EntryData => "role" in e && e.role === "user");
    expect(userEntry?.images).toBeUndefined();
  });

  test("投影快照 write-through 后 entries 含 images（持久化往返）", async () => {
    const engine = new FakeAgentEngine({ replies: [{ text: "好。" }] });
    const { chat, repo } = makeChat(engine);
    await chat.sendMessage("看图", [TINY_PNG]);
    const state = await repo.restore(chat.sessionId);
    const entry = state?.session.entries.find((e): e is EntryData => "role" in e && e.role === "user");
    expect(entry?.images).toEqual([TINY_PNG]);
  });
});

describe("T9 图片上行：校验防护（中文报错、不落消息不驱动引擎）", () => {
  test("数量超限：>4 张 → 中文错误", async () => {
    const engine = new FakeAgentEngine({ replies: [{ text: "x" }] });
    const { chat, publisher } = makeChat(engine);
    await expect(chat.sendMessage("五张图", [TINY_PNG, TINY_PNG, TINY_PNG, TINY_PNG, TINY_PNG])).rejects.toThrow(
      "图片附件最多 4 张",
    );
    expect(chat.sessionView.entryList()).toHaveLength(0); // 不落消息
    expect(publisher.domainEvents).toHaveLength(0); // 不发事件
  });

  test("坏格式：非 data URL → 中文错误", async () => {
    const engine = new FakeAgentEngine({ replies: [{ text: "x" }] });
    const { chat } = makeChat(engine);
    await expect(chat.sendMessage("坏图", ["https://example.com/a.png"])).rejects.toThrow("data URL");
  });

  test("坏格式：mimeType 非图片 → 中文错误", async () => {
    const engine = new FakeAgentEngine({ replies: [{ text: "x" }] });
    const { chat } = makeChat(engine);
    await expect(chat.sendMessage("坏图", ["data:text/plain;base64,aGVsbG8="])).rejects.toThrow("图片");
  });

  test("单张超 2MB（解码后）→ 中文错误", async () => {
    const engine = new FakeAgentEngine({ replies: [{ text: "x" }] });
    const { chat } = makeChat(engine);
    // 构造解码后 >2MB 的 base64（2MB ≈ 2,097,152 字节 → base64 ≈ 2,796,203 字符）
    const big = "data:image/png;base64," + "A".repeat(2_800_000);
    await expect(chat.sendMessage("大图", [big])).rejects.toThrow("2MB");
  });

  test("生成中带图发送：steer 不带图（非目标防护）→ 中文错误", async () => {
    const engine = new FakeAgentEngine({ replies: [{ text: "长回复……", chunkDelayMs: 60 }] });
    const { chat } = makeChat(engine);
    const first = chat.sendMessage("第一问"); // 不 await：进入 running
    await new Promise((r) => setTimeout(r, 15));
    await expect(chat.sendMessage("生成中带图", [TINY_PNG])).rejects.toThrow("生成中");
    await first;
  });
});
