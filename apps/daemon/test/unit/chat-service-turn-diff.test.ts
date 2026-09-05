import { describe, expect, test } from "bun:test";
import { ChatService } from "../../src/application/services/ChatService";
import type { EventPublisherPort, StreamDelta } from "../../src/application/ports/outbound/EventPublisherPort";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";

/**
 * T2 轮次级内存态 diff——ChatService 轮次挂点测试（fake/注入形态）：
 * - 开轮（sendMessage 空闲路径 appendUserEntry→beginTurn；steer drain
 *   dequeueSteer→beginTurn）→ onTurnBegin；
 * - 收轮两路：settleRunEnd 正常收口 completeTurn → onTurnEnd(completed)；
 *   abort 中断 interruptTurn → onTurnEnd(interrupted)；steer drain 收口
 *   finishOpenTurn → onTurnEnd(completed)；
 * - 容缺：未注入 hooks 时行为零差（不抛）。
 */

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
    return new Date(1_700_000_000_000 + this.t++).toISOString();
  }
  nowMs(): number {
    return this.t++;
  }
}

interface HookCall {
  kind: "begin" | "end";
  turnId: string;
  outcome?: "completed" | "interrupted";
}

function makeChat(engine: FakeAgentEngine, hooks?: { onTurnBegin: (turnId: string, at: string) => void; onTurnEnd: (turnId: string, outcome: "completed" | "interrupted", at: string) => void }) {
  const publisher = new RecordingPublisher();
  const calls: HookCall[] = [];
  const chat = new ChatService({
    engine,
    events: publisher,
    clock: new FixedClock(),
    ...(hooks !== undefined
      ? { turnDiff: hooks }
      : {
          turnDiff: {
            onTurnBegin: (turnId: string) => calls.push({ kind: "begin", turnId }),
            onTurnEnd: (turnId: string, outcome: "completed" | "interrupted") => calls.push({ kind: "end", turnId, outcome }),
          },
        }),
  });
  return { chat, publisher, calls };
}

async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`until 超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("① 开轮：sendMessage 空闲路径 → onTurnBegin（每轮恰一次）", () => {
  test("正常一轮：begin(turn) → end(turn, completed)；两轮各自触发", async () => {
    const engine = new FakeAgentEngine({
      replies: [{ text: "回复一。" }, { text: "回复二。" }],
    });
    const { chat, calls } = makeChat(engine);
    await chat.sendMessage("第一问");
    await chat.sendMessage("第二问");

    expect(calls.length).toBe(4);
    expect(calls[0]!.kind).toBe("begin");
    expect(calls[1]).toEqual({ kind: "end", turnId: calls[0]!.turnId, outcome: "completed" });
    expect(calls[2]!.kind).toBe("begin");
    expect(calls[3]).toEqual({ kind: "end", turnId: calls[2]!.turnId, outcome: "completed" });
    expect(calls[0]!.turnId).not.toBe(calls[2]!.turnId);
    // 挂点对齐聚合轮次（turnId = 领域 Turn id——非空标识即可）
    expect(typeof calls[0]!.turnId).toBe("string");
    expect(calls[0]!.turnId.length).toBeGreaterThan(0);
  });

  test("开轮清零语义委托：连续两轮 begin 各自触发（清零归 service——此处验证挂点节律）", async () => {
    const engine = new FakeAgentEngine({ replies: [{ text: "a" }, { text: "b" }] });
    const { chat, calls } = makeChat(engine);
    await chat.sendMessage("q1");
    await chat.sendMessage("q2");
    expect(calls.filter((c) => c.kind === "begin").length).toBe(2);
  });
});

describe("② 收轮两路：completeTurn 与 interruptTurn", () => {
  test("正常收口（agent_end）→ onTurnEnd(turnId, completed)", async () => {
    const engine = new FakeAgentEngine({ replies: [{ text: "ok" }] });
    const { chat, calls } = makeChat(engine);
    await chat.sendMessage("q");
    const begin = calls.find((c) => c.kind === "begin")!;
    expect(calls).toContainEqual({ kind: "end", turnId: begin.turnId, outcome: "completed" });
  });

  test("abort 中断 → onTurnEnd(turnId, interrupted)", async () => {
    const engine = new FakeAgentEngine({
      replies: [{ text: "这是一段较长的流式回复，留出中断窗口。", chunkDelayMs: 25 }],
    });
    const { chat, publisher, calls } = makeChat(engine);
    const run = chat.sendMessage("q");
    await until(() => publisher.deltas.length >= 2); // 流式中
    chat.abort();
    await run;
    const begin = calls.find((c) => c.kind === "begin")!;
    expect(calls).toContainEqual({ kind: "end", turnId: begin.turnId, outcome: "interrupted" });
    expect(calls.filter((c) => c.kind === "end").length).toBe(1);
  });

  test("steer drain：旧轮 finishOpenTurn → end(completed)，新轮 begin（drain 轮收口归 settleRunEnd）", async () => {
    const engine = new FakeAgentEngine({
      replies: [{ text: "一段足够长的回复，给注入留窗口。", chunkDelayMs: 20 }],
      steerReplies: [{ text: "已按注入调整。" }],
    });
    const { chat, publisher, calls } = makeChat(engine);
    const run = chat.sendMessage("写点东西");
    await until(() => publisher.deltas.length >= 2);
    const steered = await chat.sendMessage("要简短");
    expect(steered.mode).toBe("steered");
    await run;

    const begins = calls.filter((c) => c.kind === "begin");
    const ends = calls.filter((c) => c.kind === "end");
    expect(begins.length).toBe(2); // 原轮 + drain 轮
    expect(ends.length).toBe(2);
    // 旧轮（被 drain 收口）→ completed；末轮 settleRunEnd → completed
    expect(ends.every((e) => e.outcome === "completed")).toBe(true);
    // 时序：旧轮 end 先于 drain 轮 begin
    expect(calls.findIndex((c) => c.kind === "end")).toBeLessThan(calsLastBeginIndex(calls, begins[1]!.turnId));
  });

  test("挂点节律完整性：每个 begin 后必有对应 end（无悬垂轮）", async () => {
    const engine = new FakeAgentEngine({
      replies: [{ text: "第一段长回复，留出中断窗口。", chunkDelayMs: 20 }, { text: "第二轮正常回复。" }],
    });
    const { chat, publisher, calls } = makeChat(engine);
    const run1 = chat.sendMessage("q1");
    await until(() => publisher.deltas.length >= 2);
    chat.abort();
    await run1;
    await chat.sendMessage("q2");

    const begins = calls.filter((c) => c.kind === "begin");
    const ends = calls.filter((c) => c.kind === "end");
    expect(begins.length).toBe(2);
    expect(ends.length).toBe(2);
    expect(ends[0]!.outcome).toBe("interrupted");
    expect(ends[1]!.outcome).toBe("completed");
  });
});

describe("③ 容缺：未注入 turnDiff hooks → 行为零差", () => {
  test("无 hooks 的 sendMessage/abort/steer 全链路不抛（既有测试形态回归）", async () => {
    const engine = new FakeAgentEngine({
      replies: [{ text: "流式回复留窗口。", chunkDelayMs: 10 }, { text: "第二轮。" }],
      steerReplies: [{ text: "调整后。" }],
    });
    const publisher = new RecordingPublisher();
    const chat = new ChatService({ engine, events: publisher, clock: new FixedClock() });
    const run = chat.sendMessage("q1");
    await until(() => publisher.deltas.length >= 1);
    await chat.sendMessage("注入");
    await run;
    await chat.sendMessage("q2");
    expect(chat.agentState).toBe("idle");
  });
});

/** calls 中最后一个指定 turnId 的 begin 的下标。 */
function calsLastBeginIndex(calls: HookCall[], turnId: string): number {
  let idx = -1;
  calls.forEach((c, i) => {
    if (c.kind === "begin" && c.turnId === turnId) idx = i;
  });
  return idx;
}
