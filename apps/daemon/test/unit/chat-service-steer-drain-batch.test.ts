/**
 * drain 暂存队列化回归（评审 F1 续）：同一回复未落盘窗口内连续 drain 多条 steer。
 *
 * 缺陷形态：pi 引擎在 turn 边界整批注入排队中的 steer——每条注入各发一条
 * message_start(user, source=steer-drain)，而这些帧都先于旧轮
 * message_end(assistant) 到达（drain 判别的存在理由见 ChatService.drainSteerTurn
 * 头注释）。原实现用**单槽**字段 pendingDrainSteerItem 暂存延迟落盘项：两次
 * 连续 drain 时后到条目直接覆盖先到条目——先到条目已广播 steer.drained
 * （用户可见「已注入」），却永远不会进时间轴（settleRunEnd 兜底也只兜到
 * 队列里剩下的那条），用户输入静默丢失。
 *
 * 现行语义：暂存面是 FIFO 队列，recordAssistantMessage 一次落盘整批——
 * 首条开新轮（TR-25 单轮不变式：不二次 beginTurn），同批余条以 drained user
 * 条目落在同一轮内，时间轴顺序 = drain 顺序。
 */
import { describe, expect, test } from "bun:test";
import { ChatService } from "../../src/application/services/ChatService";
import { SessionProjection } from "../../src/application/services/SessionProjection";
import type { EventPublisherPort, StreamDelta } from "../../src/application/ports/outbound/EventPublisherPort";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import type { AgentEngineEvent, AgentEnginePort, AgentEngineListener } from "../../src/application/ports/outbound/AgentEnginePort";
import { InMemorySessionRepository } from "../mocks/InMemorySessionRepository";

/** 录音式 EventPublisherPort（chat-service-steer-orphan.test.ts 同构，独立内联）。 */
class RecordingPublisher implements EventPublisherPort {
  readonly domainEvents: DomainEvent[] = [];
  readonly deltas: StreamDelta[] = [];
  private readonly targets: EventPublisherPort[] = [];

  addTarget(target: EventPublisherPort): void {
    this.targets.push(target);
  }
  publish(event: DomainEvent): void {
    this.domainEvents.push(event);
    for (const t of this.targets) t.publish(event);
  }
  publishDelta(delta: StreamDelta): void {
    this.deltas.push(delta);
    for (const t of this.targets) t.publishDelta(delta);
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * pi 批注时序引擎：steer() 只入内部队列（pi 内建 pending），run 循环在
 * turn 边界把排队条目**整批**注入——逐条发 message_start(user, steer-drain)，
 * 全部先于旧轮 message_end(assistant) 到达。
 */
class BatchDrainEngine implements AgentEnginePort {
  readonly steered: string[] = [];
  private listener: AgentEngineListener | null = null;
  private streaming = false;
  private readonly queued: string[] = [];

  async start(_input: string, listener: AgentEngineListener): Promise<void> {
    this.listener = listener;
    this.streaming = true;
    this.emit({ type: "agent_start" });
    this.emit({ type: "turn_start" });
    this.emit({ type: "message_start", role: "assistant", source: "prompt" });
    this.emit({ type: "message_update", delta: "正在生成回复……" });
    await sleep(20); // 注入窗口：两次 steer 先后入队（此间无 drain 帧）
    for (let i = 0; i < this.queued.length; i++) {
      this.emit({ type: "message_start", role: "user", source: "steer-drain" });
    }
    await sleep(5);
    this.emit({ type: "message_end", role: "assistant", text: "正在生成回复……", stopReason: "stop" });
    this.emit({ type: "turn_end", toolResultCount: 0 });
    this.emit({ type: "agent_end", messageCount: 2 });
    this.streaming = false;
    this.listener = null;
  }

  steer(text: string): void {
    this.steered.push(text);
    this.queued.push(text); // pi 内部队列：drain 帧由 run 循环在 turn 边界发出
  }
  abort(): void {
    /* 本测试不用 */
  }
  isStreaming(): boolean {
    return this.streaming;
  }

  private emit(e: AgentEngineEvent): void {
    this.listener?.(e);
  }
}

function makeChat(engine: AgentEnginePort) {
  const publisher = new RecordingPublisher();
  const repo = new InMemorySessionRepository();
  const chat = new ChatService({ engine, events: publisher, clock: new FixedClock() });
  const projection = new SessionProjection({
    repository: repo,
    getSession: () => chat.sessionView,
    getMainState: () => ({ agentState: chat.agentState, toolCalls: chat.toolCallData }),
  });
  publisher.addTarget(projection);
  return { chat, publisher, domainEvents: publisher.domainEvents };
}

async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`until 超时（${timeoutMs}ms）`);
    await sleep(5);
  }
}

/** message.completed（user，drained 两态）文本序列。 */
function drainedTexts(events: readonly DomainEvent[]): string[] {
  return events
    .filter((e) => e.type === "message.completed")
    .map((e) => e.payload as { role?: string; text?: string; steerState?: string })
    .filter((p) => p.role === "user" && p.steerState === "drained")
    .map((p) => p.text ?? "");
}

describe("F1 续：同窗口连续 drain 多条 steer → 暂存队列保序落盘，零丢条目", () => {
  test("两条 steer 在同一回复未落盘窗口内 drain → 两条都进时间轴且顺序 = drain 顺序", async () => {
    const engine = new BatchDrainEngine();
    const { chat, publisher, domainEvents } = makeChat(engine);

    const run = chat.sendMessage("主线任务");
    await until(() => publisher.deltas.length >= 1);
    await chat.steer("第一条注入");
    await chat.steer("第二条注入");
    await run;
    await until(() => chat.agentState === "idle");

    // drain 侧事实：两条都广播过 steer.drained（用户可见「已注入」）
    const drainedFrames = domainEvents.filter((e) => e.type === "steer.drained");
    expect(drainedFrames).toHaveLength(2);
    // 时间轴事实：两条都要落盘（修复前只剩后一条——先到条目静默丢失）
    expect(drainedTexts(domainEvents)).toEqual(["第一条注入", "第二条注入"]);
    // 队列面清空（无孤儿残留）
    expect(chat.sessionSnapshot.pendingSteer).toHaveLength(0);
  });
});
