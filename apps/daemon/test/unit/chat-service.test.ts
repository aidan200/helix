import { describe, expect, test } from "bun:test";
import { ChatService } from "../../src/application/services/ChatService";
import type { EventPublisherPort, StreamDelta } from "../../src/application/ports/outbound/EventPublisherPort";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { InMemorySessionRepository } from "../mocks/InMemorySessionRepository";

/**
 * TP-CL4-1 / TP-CL4-8（U 半）：ChatService 编排——
 * ① 空闲 sendMessage 驱动新 turn（领域事件按序发 EventPublisherPort）；
 * ② 运行中 sendMessage 转 steer 入队（可观测）→ turn 边界 drain → 注入驱动新回复；
 * ③ abort 转发 + abort 非销毁（后续消息正常对话）；
 * ④ 工具轮事件 → ToolCallRecord 领域事件；
 * ⑤ FakeAgentEngine 时序契约自检（spike §5.1/5.3/5.4 等价）。
 */

/** 录音式 EventPublisherPort：记录领域事件与流式 delta（断言源）。 */
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
}

/** 轮询等待条件成立（时序测试用）。 */
async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`until 超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makeChat(engine: FakeAgentEngine) {
  const publisher = new RecordingPublisher();
  const repo = new InMemorySessionRepository();
  const chat = new ChatService({ engine, repository: repo, events: publisher, clock: new FixedClock() });
  return { chat, publisher, repo };
}

describe("① 空闲 sendMessage 驱动新 turn（TP-CL4-1）", () => {
  test("事件按序、聚合落账、快照落盘、回复流式直达", async () => {
    const engine = new FakeAgentEngine({
      replies: [{ text: "你好，我是回复一。" }],
    });
    const { chat, publisher, repo } = makeChat(engine);

    const outcome = await chat.sendMessage("第一问");
    expect(outcome.mode).toBe("turn");

    // 领域事件按序（业务流转：user 落账 → turn 开始 → running → assistant 完成 → turn 完成 → idle）
    expect(publisher.domainEvents.map((e) => e.type)).toEqual([
      "message.completed",
      "turn.started",
      "agent.state.changed",
      "message.completed",
      "turn.completed",
      "agent.state.changed",
    ]);
    expect(publisher.domainEvents[2]!.payload).toEqual({ state: "running" });
    expect(publisher.domainEvents[5]!.payload).toEqual({ state: "idle" });

    // 流式 delta 直达（非领域事件）
    expect(publisher.deltas.length).toBeGreaterThan(0);
    expect(publisher.deltas.map((d) => d.delta).join("")).toBe("你好，我是回复一。");

    // 聚合落账：user + assistant entry，turn completed；快照已 save
    const snap = chat.sessionSnapshot;
    expect(snap.entries.map((e) => e.role)).toEqual(["user", "assistant"]);
    expect(snap.turns[0]!.status).toBe("completed");
    expect((await repo.restore(chat.sessionId))?.session.entries.length).toBe(2);
  });
});

describe("② 运行中 sendMessage 转 steer（TP-CL4-8 U 半）", () => {
  test("生成中输入 → steer.queued 可观测 → drain 边界注入 → 新回复由注入驱动", async () => {
    const engine = new FakeAgentEngine({
      replies: [{ text: "这是一段足够长的回复，给测试留出流式注入窗口。", chunkDelayMs: 12 }],
      steerReplies: [{ text: "（已按注入调整）好的，改用简洁风格。" }],
    });
    const { chat, publisher } = makeChat(engine);

    const run = chat.sendMessage("写一段介绍");
    await until(() => publisher.deltas.length >= 2); // 流式进行中

    const steerOutcome = await chat.sendMessage("要简短一些");
    expect(steerOutcome.mode).toBe("steered");

    // 入队即观测：steer.queued 已发，且 lifecycle 转入 steering
    expect(publisher.domainEvents.some((e) => e.type === "steer.queued")).toBe(true);
    expect(chat.agentState).toBe("steering");

    await run; // 整个 run（含 drain 轮）结束

    // drain 观测：steer.drained 事件 + 注入驱动的回复落账
    const types = publisher.domainEvents.map((e) => e.type);
    expect(types).toContain("steer.drained");
    expect(types.indexOf("steer.drained")).toBeGreaterThan(types.indexOf("steer.queued"));

    const snap = chat.sessionSnapshot;
    expect(snap.entries.filter((e) => e.isSteer).length).toBe(1); // isSteer entry
    expect(snap.entries.at(-1)!.text).toBe("（已按注入调整）好的，改用简洁风格。");
    expect(snap.turns.length).toBe(2); // 原 turn（steerDrained 收口）+ 注入驱动的新 turn
    expect(snap.turns.every((t) => t.status === "completed")).toBe(true);

    // 引擎侧时序：drain 的 user 消息是新 turn 首条（§5.3）
    const drainStart = engine.events.findIndex(
      (e) => e.type === "message_start" && e.role === "user" && e.source === "steer-drain",
    );
    const prevTurnEnd = engine.events.map((e) => e.type).lastIndexOf("turn_end");
    expect(drainStart).toBeGreaterThan(prevTurnEnd - 20); // 位于 turn 边界之后
  });

  test("idle 时显式 steer() 抛业务错误", async () => {
    const engine = new FakeAgentEngine();
    const { chat } = makeChat(engine);
    await expect(chat.steer("没在运行")).rejects.toThrow();
  });
});

describe("③ abort 转发与非销毁（TP-CL4-9 U 半）", () => {
  test("abort → aborting → turn.interrupted → idle；之后新消息正常对话", async () => {
    const engine = new FakeAgentEngine({
      replies: [
        { text: "很长很长很长很长很长很长很长很长的回复占满流式窗口。", chunkDelayMs: 15 },
        { text: "abort 后的第二次回复。" },
      ],
    });
    const { chat, publisher } = makeChat(engine);

    const run = chat.sendMessage("第一问");
    await until(() => publisher.deltas.length >= 2);
    chat.abort();
    expect(chat.agentState).toBe("aborting");
    await run;

    const types = publisher.domainEvents.map((e) => e.type);
    expect(types).toContain("turn.interrupted");
    expect(chat.agentState).toBe("idle");
    expect(engine.lastErrorMessage).toBe("The operation was aborted.");

    // 非销毁：abort 后再发新消息，正常流式回复并完成
    const outcome = await chat.sendMessage("继续问");
    expect(outcome.mode).toBe("turn");
    const snap = chat.sessionSnapshot;
    expect(snap.turns[0]!.status).toBe("interrupted");
    expect(snap.turns[1]!.status).toBe("completed");
    expect(snap.entries.at(-1)!.text).toBe("abort 后的第二次回复。");
  });

  test("空闲 abort 幂等（无状态变更）", () => {
    const engine = new FakeAgentEngine();
    const { chat } = makeChat(engine);
    expect(() => chat.abort()).not.toThrow();
    expect(chat.agentState).toBe("idle");
  });
});

describe("④ 工具轮领域事件（TP-CL4-1）", () => {
  test("tool.call.started/result 按序发出，轮次经 toolRunning 回 generating 后完成", async () => {
    const engine = new FakeAgentEngine({
      replies: [
        {
          toolCalls: [{ toolName: "bash", args: { command: "echo hi" }, result: "hi" }],
          text: "工具结果已处理。",
        },
      ],
    });
    const { chat, publisher } = makeChat(engine);
    await chat.sendMessage("跑个命令");

    const types = publisher.domainEvents.map((e) => e.type);
    expect(types).toContain("tool.call.started");
    expect(types.indexOf("tool.call.result")).toBeGreaterThan(types.indexOf("tool.call.started"));
    const snap = chat.sessionSnapshot;
    expect(snap.turns[0]!.status).toBe("completed");
    expect(snap.entries.at(-1)!.text).toBe("工具结果已处理。");
  });
});

describe("⑥ 回退修复①（verif-rollback）：D-1 观测面 / D-2 messageId 对齐 / 恢复收口", () => {
  test("流式 delta 的 messageId === 本轮 message.completed(assistant) 的 entryId（D-2）", async () => {
    const engine = new FakeAgentEngine({ replies: [{ text: "对齐消息 id 的流式回复。", chunkDelayMs: 6 }] });
    const { chat, publisher } = makeChat(engine);
    await chat.sendMessage("对齐吗");

    expect(publisher.deltas.length).toBeGreaterThan(0);
    const assistantCompleted = publisher.domainEvents.find(
      (e) => e.type === "message.completed" && (e.payload as { role: string }).role === "assistant",
    )!;
    const assistantEntryId = (assistantCompleted.payload as { entryId: string }).entryId;
    // 每片 delta 的 messageId 都是最终 assistant entry id（流式期间已预分配，契约 §5 字段语义）
    for (const d of publisher.deltas) {
      expect(d.messageId).toBe(assistantEntryId);
    }
  });

  test("工具轮后 toolCallData 观测面可取（三态/时间戳完整，D-1 取数面）", async () => {
    const engine = new FakeAgentEngine({
      replies: [
        {
          toolCalls: [{ toolName: "bash", args: { command: "echo hi" }, result: "hi" }],
          text: "工具已执行。",
        },
      ],
    });
    const { chat, publisher } = makeChat(engine);
    await chat.sendMessage("跑个工具");

    const records = chat.toolCallData;
    expect(records).toHaveLength(1);
    expect(records[0]!.toolName).toBe("bash");
    expect(records[0]!.status).toBe("completed");
    expect(records[0]!.result).toBe("hi");
    expect(records[0]!.startedAt).toBeDefined();
    expect(records[0]!.endedAt).toBeDefined();
    // persistedState.toolCalls 与观测面一致（持久化载荷不变）
    expect(chat.persistedState.toolCalls).toEqual([...records]);
    expect(publisher.domainEvents.some((e) => e.type === "tool.call.result")).toBe(true);
  });

  test("恢复时非终态（pending/running）工具记录收口 failed，终态原样保留（D-1 恢复语义）", () => {
    const engine = new FakeAgentEngine();
    const chat = new ChatService({
      engine,
      repository: new InMemorySessionRepository(),
      events: new RecordingPublisher(),
      clock: new FixedClock(),
      restoredToolCalls: [
        { id: "tc-running", toolName: "bash", args: {}, status: "running", startedAt: "2026-08-15T00:00:01.000Z" },
        { id: "tc-pending", toolName: "grep", args: {}, status: "pending" },
        {
          id: "tc-done",
          toolName: "ok",
          args: {},
          status: "completed",
          result: "已完成的原样保留",
          startedAt: "2026-08-15T00:00:02.000Z",
          endedAt: "2026-08-15T00:00:03.000Z",
        },
      ],
    });
    const byId = new Map(chat.toolCallData.map((r) => [r.id, r]));
    expect(byId.get("tc-running")!.status).toBe("failed");
    expect(byId.get("tc-running")!.error).toBe("daemon 重启，工具调用未完成（恢复时收口）");
    expect(byId.get("tc-running")!.endedAt).toBeDefined();
    expect(byId.get("tc-pending")!.status).toBe("failed"); // pending 先 markRunning 再 fail（startedAt 不回填，ts 映射回退 endedAt）
    expect(byId.get("tc-pending")!.endedAt).toBeDefined();
    expect(byId.get("tc-done")!.status).toBe("completed"); // 终态不动
    expect(byId.get("tc-done")!.result).toBe("已完成的原样保留");
  });
});

describe("⑤ FakeAgentEngine 时序契约自检（spike §5 等价）", () => {
  test("§5.1 无工具轮规范序", async () => {
    const engine = new FakeAgentEngine({ replies: [{ text: "abc" }] });
    await engine.start("q", () => {});
    expect(engine.events.map((e) => e.type)).toEqual([
      "agent_start",
      "turn_start",
      "message_start",
      "message_end",
      "message_start",
      "message_update",
      "message_end",
      "turn_end",
      "agent_end",
    ]);
  });

  test("§5.3 steer 即时入队 + drain 独占 turn + one-at-a-time 顺序", async () => {
    const engine = new FakeAgentEngine({
      replies: [{ text: "第一答", chunkDelayMs: 6 }],
      steerReplies: [{ text: "对注入一的答" }, { text: "对注入二的答" }],
    });
    const done = engine.start("q", () => {});
    engine.steer("注入一");
    expect(engine.hasQueued()).toBe(true); // §5.3-1 即时可观测（run 中入队）
    engine.steer("注入二");
    await done;

    // 每条 steer 独占一个 turn，按入队顺序（§5.3-4）
    const drainOrder = engine.events
      .filter((e) => e.type === "message_start" && e.role === "user")
      .map((e) => (e as { source: string }).source);
    expect(drainOrder).toEqual(["prompt", "steer-drain", "steer-drain"]);
    expect(engine.queuedCount).toBe(0);
  });

  test("§5.4 abort 非销毁：同实例可继续 start", async () => {
    const engine = new FakeAgentEngine({
      replies: [{ text: "会被打断的回复", chunkDelayMs: 20 }, { text: "第二次回复" }],
    });
    const first = engine.start("q1", () => {});
    await new Promise((r) => setTimeout(r, 30));
    engine.abort();
    await first;
    expect(engine.isStreaming()).toBe(false);
    expect(engine.lastErrorMessage).toBe("The operation was aborted.");

    await engine.start("q2", () => {}); // 同实例继续——非销毁
    expect(engine.events.at(-1)!.type).toBe("agent_end");
  });
});
