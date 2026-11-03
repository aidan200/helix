import { describe, expect, test } from "bun:test";
import { ChatService } from "../../src/application/services/ChatService";
import type { EventPublisherPort, StreamDelta } from "../../src/application/ports/outbound/EventPublisherPort";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import type { AgentEngineListener, AgentEnginePort } from "../../src/application/ports/outbound/AgentEnginePort";

/**
 * P0 abort 收口批（2026-11-03 事故回归锚）：abort 发出但引擎不回
 * agent_end（执行中工具无 abort 感知——裸跑 cargo 挂 20 分钟实证）→
 * 宽限到点机械 settleRunEnd 回 idle + engine.error 可观测——「停止」
 * 按钮必须永远有效。
 *
 * 用例锚定三层：
 * 1. 宽限强制收口：挂起 run + abort 无效 → 宽限到点 → interrupted + 告警 + idle；
 * 2. 宽限内正常收口不误伤：agent_end 先到 → 无告警、无重复 interrupted；
 * 3. 强制收口后 late agent_end 无害：幂等面吞掉，不重复事件。
 */

class RecordingPublisher implements EventPublisherPort {
  readonly domainEvents: DomainEvent[] = [];
  publish(event: DomainEvent): void {
    this.domainEvents.push(event);
  }
  publishDelta(_delta: StreamDelta): void {}
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

/** 挂起引擎：start 永不结束（模拟工具 await 挂死），abort 无感（只记不发事件）。 */
class HangingEngine implements AgentEnginePort {
  listener: AgentEngineListener | null = null;
  abortCalls = 0;
  async start(_input: string, listener: AgentEngineListener): Promise<void> {
    this.listener = listener;
    await new Promise<never>(() => {}); // 永挂：run 不收口
  }
  steer(): void {}
  abort(): void {
    this.abortCalls++; // 无感：不驱动任何事件（实证形态）
  }
  isStreaming(): boolean {
    return true;
  }
}

/** 快速收口引擎：abort() 即回 agent_end（正常协作形态）。 */
class CooperativeAbortEngine implements AgentEnginePort {
  listener: AgentEngineListener | null = null;
  private resolveStart: (() => void) | null = null;
  async start(_input: string, listener: AgentEngineListener): Promise<void> {
    this.listener = listener;
    await new Promise<void>((resolve) => {
      this.resolveStart = resolve;
    });
  }
  steer(): void {}
  abort(): void {
    this.listener?.({ type: "agent_end", messageCount: 1 });
    this.resolveStart?.();
  }
  isStreaming(): boolean {
    return true;
  }
}

function countEvents(publisher: RecordingPublisher, type: string): number {
  return publisher.domainEvents.filter((e) => e.type === type).length;
}

function engineErrorMessages(publisher: RecordingPublisher): string[] {
  return publisher.domainEvents
    .filter((e) => e.type === "engine.error")
    .map((e) => String((e.payload as { message?: string } | undefined)?.message ?? ""));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function makeService(engine: AgentEnginePort, publisher: RecordingPublisher, graceMs: number): ChatService {
  return new ChatService({
    engine,
    events: publisher,
    clock: new FixedClock(),
    abortGraceMs: graceMs,
  } as never);
}

describe("ChatService abort 宽限强制收口（P0 abort 收口批）", () => {
  test("引擎挂死 + abort 无感 → 宽限到点强制收口：interrupted + engine.error 告警 + 回 idle", async () => {
    const engine = new HangingEngine();
    const publisher = new RecordingPublisher();
    const chat = makeService(engine, publisher, 20);
    void chat.sendMessage("跑个长命令");
    await sleep(5); // 等 run 起飞（lifecycle=running）
    chat.abort();
    expect(engine.abortCalls).toBe(1);
    await sleep(50); // 宽限 20ms 已过
    expect(countEvents(publisher, "turn.interrupted")).toBe(1);
    const errs = engineErrorMessages(publisher);
    expect(errs.some((m) => m.includes("宽限"))).toBe(true);
    const states = publisher.domainEvents
      .filter((e) => e.type === "agent.state.changed")
      .map((e) => (e.payload as { state?: string }).state);
    expect(states).toContain("idle");
    // 停止后再发消息不被 aborting 拒收（会话可用性恢复）
    expect(() => chat.abort()).not.toThrow(); // 幂等：二次 abort 静默
  });

  test("宽限内引擎正常收口（abort 协作）→ 无告警、无重复 interrupted", async () => {
    const engine = new CooperativeAbortEngine();
    const publisher = new RecordingPublisher();
    const chat = makeService(engine, publisher, 20);
    const sending = chat.sendMessage("正常流程");
    await sleep(5);
    chat.abort(); // 引擎即回 agent_end
    await sending;
    await sleep(40); // 宽限窗早已过——但已收口，不触发
    expect(countEvents(publisher, "turn.interrupted")).toBe(1);
    expect(engineErrorMessages(publisher).some((m) => m.includes("宽限"))).toBe(false);
    const states = publisher.domainEvents
      .filter((e) => e.type === "agent.state.changed")
      .map((e) => (e.payload as { state?: string }).state);
    expect(states[states.length - 1]).toBe("idle");
  });

  test("强制收口后 late agent_end 到达 → 无害（不产生重复 interrupted/告警）", async () => {
    const engine = new HangingEngine();
    const publisher = new RecordingPublisher();
    const chat = makeService(engine, publisher, 20);
    void chat.sendMessage("挂死流程");
    await sleep(5);
    chat.abort();
    await sleep(50); // 强制收口已完成
    const interruptedBefore = countEvents(publisher, "turn.interrupted");
    // late agent_end：引擎终于醒了（工具 20 分钟后返回的形态）
    engine.listener?.({ type: "agent_end", messageCount: 1 });
    await sleep(10);
    expect(countEvents(publisher, "turn.interrupted")).toBe(interruptedBefore); // 不重复
    expect(engineErrorMessages(publisher).filter((m) => m.includes("宽限")).length).toBe(1); // 告警仍只一条
  });
});
