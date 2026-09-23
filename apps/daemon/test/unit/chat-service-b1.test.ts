/**
 * B1 管家文本链路批 ChatService 钉子（设计稿 §3.6/§3.4）：
 *
 * 1. steer source 透传：steer(text, undefined, "steward") → steer.queued
 *    payload {source:"steward", text} + isSteer Entry 带 source（管家投递
 *    与手动输入可辨——G7）；
 * 2. sendMessage running 分支 source 透传：sendMessage(…, "steward") 生成中
 *    → 转 steer 入队携带 source；
 * 3. sendMessage idle 分支 source 落 Entry + message.completed 载荷（daemon
 *    侧单点透传——徽标渲染的数据源）；
 * 4. fireAndForget（B1 受理即回）：idle 目标全轮不再上浮等待——
 *    sendMessage(…, {fireAndForget:true}) 毫秒级返回（turn 已开、user 已
 *    落账、引擎已驱动），轮次照常完成（activeRun 不残留）。
 */
import { describe, expect, test } from "bun:test";
import { ChatService } from "../../src/application/services/ChatService";
import type { EventPublisherPort, StreamDelta } from "../../src/application/ports/outbound/EventPublisherPort";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { InMemorySessionRepository } from "../mocks/InMemorySessionRepository";
import type { SteerQueuedPayload } from "@helix/protocol";

class RecordingPublisher implements EventPublisherPort {
  readonly domainEvents: DomainEvent[] = [];
  readonly deltas: StreamDelta[] = [];
  publish(event: DomainEvent): void {
    this.domainEvents.push(event);
  }
  publishDelta(delta: StreamDelta): void {
    this.deltas.push(delta);
  }
}

class FixedClock {
  private t = 0;
  now(): string {
    return new Date(this.t++).toISOString();
  }
  nowMs(): number {
    return this.t++;
  }
}

function makeChat(engine: FakeAgentEngine) {
  const publisher = new RecordingPublisher();
  const chat = new ChatService({ engine, events: publisher, clock: new FixedClock() });
  return { chat, publisher };
}

const steerQueuedOf = (events: readonly DomainEvent[]): SteerQueuedPayload[] =>
  events.filter((e) => e.type === "steer.queued").map((e) => e.payload as SteerQueuedPayload);

describe("B1：steer source 透传（SteerSource +\"steward\"——G7）", () => {
  test("steer(text, undefined, \"steward\") → steer.queued 携 {source, text} + Entry 带 source", async () => {
    const engine = new FakeAgentEngine({
      replies: [{ text: "首轮回复。" }],
      steerReplies: [{ text: "注入后的回复。" }],
    });
    const { chat, publisher } = makeChat(engine);
    // 先开一轮（running 态才可 steer）
    const first = chat.sendMessage("第一问");
    await new Promise((r) => setTimeout(r, 5)); // 进入流式中段
    const outcome = await chat.steer("管家投递的指令", undefined, "steward");
    expect(typeof outcome.entryId).toBe("string");
    const queued = steerQueuedOf(publisher.domainEvents);
    expect(queued.length).toBe(1);
    expect(queued[0]!.source).toBe("steward");
    expect(queued[0]!.text).toBe("管家投递的指令"); // create-if-no-echo 建条目依据
    // drain 落盘 Entry 带 source
    await first;
    await new Promise((r) => setTimeout(r, 80));
    const snap = chat.sessionSnapshot;
    const steerEntry = snap.entries.find((e) => "source" in e && e.source === "steward");
    expect(steerEntry).toBeDefined();
  });

  test("sendMessage running 分支 source 透传：生成中投递 → steer.queued source=\"steward\"", async () => {
    const engine = new FakeAgentEngine({
      replies: [{ text: "长轮次回复。", chunkDelayMs: 20 }],
      steerReplies: [{ text: "注入回复。" }],
    });
    const { chat, publisher } = makeChat(engine);
    const first = chat.sendMessage("第一问");
    await new Promise((r) => setTimeout(r, 15)); // 流式中段（running）
    const outcome = await chat.sendMessage("管家在生成中的投递", undefined, "steward");
    expect(outcome.mode).toBe("steered");
    const queued = steerQueuedOf(publisher.domainEvents);
    expect(queued[0]!.source).toBe("steward");
    await first;
    await new Promise((r) => setTimeout(r, 120));
  });

  test("sendMessage idle 分支 source 落 Entry + message.completed 载荷（\"steward\" 与缺省 user 分流）", async () => {
    const engine = new FakeAgentEngine({
      replies: [
        { text: "回一。" },
        { text: "回二。" },
      ],
    });
    const { chat, publisher } = makeChat(engine);
    await chat.sendMessage("手动输入", undefined, undefined); // 缺省 = user
    await chat.sendMessage("管家投递", undefined, "steward");
    const userEntries = publisher.domainEvents.filter(
      (e) => e.type === "message.completed" && (e.payload as { role?: string }).role === "user",
    );
    expect(userEntries.length).toBe(2);
    expect((userEntries[0]!.payload as { source?: string }).source).toBeUndefined(); // 缺省不带（老口径）
    expect((userEntries[1]!.payload as { source?: string }).source).toBe("steward");
  });
});

describe("B1：sendMessage fireAndForget（管家投递受理即回——G1 daemon 侧半面）", () => {
  test("idle 投递受理即回：长轮次不阻塞（毫秒级），轮次照常完成", async () => {
    const engine = new FakeAgentEngine({
      replies: [{ text: "这是一个模拟长轮次的回复。", chunkDelayMs: 60 }],
    });
    const { chat, publisher } = makeChat(engine);
    const started = Date.now();
    const outcome = await chat.sendMessage("管家投递到空闲会话", undefined, "steward", { fireAndForget: true });
    const elapsed = Date.now() - started;
    expect(outcome.mode).toBe("turn");
    expect(elapsed).toBeLessThan(50); // 受理即回——不等 60ms×N 分片的全轮
    // 轮次照常完成（引擎驱动未被跳过）
    await new Promise((r) => setTimeout(r, 400));
    const types = publisher.domainEvents.map((e) => e.type);
    expect(types).toContain("turn.completed");
    // user Entry 已落账（受理段同步完成）+ source 落位
    const snap = chat.sessionSnapshot;
    const userEntry = snap.entries.find((e) => "role" in e && e.role === "user");
    expect(userEntry && "source" in userEntry ? userEntry.source : undefined).toBe("steward");
    // activeRun 不残留：下一轮 sendMessage 正常受理
    const second = await chat.sendMessage("下一问", undefined, undefined, { fireAndForget: true });
    expect(second.mode).toBe("turn");
  });
});
