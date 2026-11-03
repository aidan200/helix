/**
 * chat.turn.completed 帧的 lastReplyExcerpt 流上投影（与 fallbackTurnId/
 * durationMs 同构：EventStream 维护、EnvelopeMapper 注入、不落 domain_events）。
 * 摘录 = 本轮最后一条 assistant 回复的单行化（空白折叠 + 80 码点截断）——
 * 系统通知正文/后台预览消费；user 条目不入、turn 收口即清、interrupted 不带。
 */
import { describe, expect, test } from "bun:test";
import { EventStream } from "../../src/adapters/driving/ws-server/EventStream";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";

const T = (ms: number) => new Date(ms).toISOString();

function ev(type: DomainEvent["type"], payload: unknown, at: number): DomainEvent {
  return { type, sessionId: "s1", instanceId: undefined, payload, occurredAt: T(at) };
}

// 载荷形态 = MessageCompletedPayload 扁平形态（主线 ChatService 与 SubAgent
// 转译器同构发布；复盘批：初版误用投影层 EntryDto 嵌套形态致真机永不命中）
function msgEntry(role: "assistant" | "user", content: string) {
  return { entryId: `m-${role}`, role, text: content, isSteer: false };
}

function run(...events: DomainEvent[]): { type: string; payload: Record<string, unknown> }[] {
  const es = new EventStream();
  const frames: { type: string; payload: Record<string, unknown> }[] = [];
  es.attach((f) => frames.push(f as { type: string; payload: Record<string, unknown> }), "s1");
  for (const e of events) es.publish(e);
  return frames;
}

const turnDone = ev("turn.completed", { reason: "done", replyEntryId: undefined }, 9000);

describe("EventStream：turn.completed 帧注入 assistant 摘录", () => {
  test("assistant message.completed → 下一 turn.completed 帧带单行化摘录", () => {
    const frames = run(
      ev("message.completed", msgEntry("assistant", "第一段\n\n第二行  有连续空白"), 1000),
      turnDone,
    );
    const f = frames.find((x) => x.type === "chat.turn.completed");
    expect(f).toBeDefined();
    expect((f!.payload as { lastReplyExcerpt?: string }).lastReplyExcerpt).toBe(
      "第一段 第二行 有连续空白",
    );
  });

  test("多消息轮次取最后一条 assistant 文本（流上覆写 = 最终回复）", () => {
    const frames = run(
      ev("message.completed", msgEntry("assistant", "中间态文本"), 1000),
      ev("message.completed", msgEntry("assistant", "最终回复文本"), 2000),
      turnDone,
    );
    const f = frames.find((x) => x.type === "chat.turn.completed");
    expect((f!.payload as { lastReplyExcerpt?: string }).lastReplyExcerpt).toBe("最终回复文本");
  });

  test("80 码点截断 + 省略号（按码点切，emoji 代理对不截半）", () => {
    const long = "字".repeat(79) + "😀" + "尾";
    const frames = run(ev("message.completed", msgEntry("assistant", long), 1000), turnDone);
    const f = frames.find((x) => x.type === "chat.turn.completed");
    const got = (f!.payload as { lastReplyExcerpt?: string }).lastReplyExcerpt ?? "";
    expect(Array.from(got)).toHaveLength(81); // 80 码点 + 省略号
    expect(got.endsWith("😀…")).toBe(true);
  });

  test("user 条目不入摘录（用户自己的话不上回复摘要面）", () => {
    const frames = run(ev("message.completed", msgEntry("user", "用户提问"), 1000), turnDone);
    const f = frames.find((x) => x.type === "chat.turn.completed");
    expect("lastReplyExcerpt" in f!.payload).toBe(false);
  });

  test("turn 收口即清：下一轮无 assistant 文本 → 帧不含键（旧消费面安全）", () => {
    const frames = run(
      ev("message.completed", msgEntry("assistant", "第一轮回复"), 1000),
      turnDone,
      ev("turn.started", { turnId: "t2" }, 2000),
      ev("turn.completed", { reason: "done", replyEntryId: undefined }, 3000),
    );
    const dones = frames.filter((x) => x.type === "chat.turn.completed");
    expect(dones).toHaveLength(2);
    expect("lastReplyExcerpt" in dones[0]!.payload).toBe(true);
    expect("lastReplyExcerpt" in dones[1]!.payload).toBe(false);
  });

  test("interrupted 收口不带摘录且同样清仓", () => {
    const frames = run(
      ev("message.completed", msgEntry("assistant", "被打断前的文本"), 1000),
      ev("turn.interrupted", { reason: "user-abort" }, 2000),
      turnDone,
    );
    const interrupted = frames.filter((x) => x.type === "chat.turn.completed")[0];
    expect("lastReplyExcerpt" in interrupted!.payload).toBe(false);
  });
});
