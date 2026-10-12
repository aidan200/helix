import { describe, expect, test } from "bun:test";
import { ChatService } from "../../src/application/services/ChatService";
import type { EventPublisherPort, StreamDelta } from "../../src/application/ports/outbound/EventPublisherPort";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import type {
  AgentEngineListener,
  AgentEnginePort,
  EngineResumeDecision,
} from "../../src/application/ports/outbound/AgentEnginePort";

/**
 * 审批闸接线批（最窄档）：ChatService 消费 engine_paused → 走 AskService
 * 卡片仲裁（ask.started UI 双帧复用）→ 裁决映射 resume 四态。
 *
 * 链路：ApprovalGateHook 挂闸（permission_request）→ adapter 发
 * engine_paused → 本桥调 ask.request（复用 60s 超时/answer/快照面）→
 * outcome 映射：approved → resume(approve)（放行工具裸跑）；denied/
 * timeout → resume(reject + 引导文案——模型知情改道）。
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

/** 闸桩引擎：start 内发 engine_paused（挂闸语义），记录 resume 调用。 */
class GatedStubEngine implements AgentEnginePort {
  resumes: { pauseToken: string; decision: EngineResumeDecision }[] = [];
  constructor(private readonly gateArgs: unknown) {}
  async start(_input: string, listener: AgentEngineListener): Promise<void> {
    listener({
      type: "engine_paused",
      pauseToken: "tok-1",
      toolCallId: "tc-1",
      toolName: "permission_request",
      argsSummary: "(summary)",
      args: this.gateArgs,
    });
    listener({ type: "message_start", role: "assistant", source: "prompt" });
    listener({ type: "message_update", delta: "好的" });
    listener({ type: "message_end", role: "assistant", text: "好的", stopReason: "stop" });
    listener({ type: "turn_end", toolResultCount: 0 });
    listener({ type: "agent_end", messageCount: 1 });
  }
  steer(): void {}
  abort(): void {}
  isStreaming(): boolean {
    return false;
  }
  async resume(pauseToken: string, decision: EngineResumeDecision): Promise<void> {
    this.resumes.push({ pauseToken, decision });
  }
}

/** AskService 桩：request 记录入参，按剧本裁决。 */
class StubAsk {
  requests: { sessionId: string; instanceId: string; command: string; reason: string; kind?: string }[] = [];
  constructor(private readonly outcome: "approved" | "denied" | "timeout" | "auto_approved" | "throw") {}
  request(input: {
    sessionId: string;
    instanceId: string;
    command: string;
    reason: string;
    kind?: string;
  }): Promise<"approved" | "denied" | "timeout" | "auto_approved"> {
    this.requests.push(input);
    if (this.outcome === "throw") return Promise.reject(new Error("会话已有挂起的提权申请"));
    return Promise.resolve(this.outcome);
  }
}

const GATE_ARGS = { command: "bun install -g pkg", reason: "需要全局安装" };

async function runOnce(engine: AgentEnginePort, ask?: StubAsk) {
  const publisher = new RecordingPublisher();
  const chat = new ChatService({
    engine,
    events: publisher,
    clock: new FixedClock(),
    ...(ask !== undefined ? { ask } : {}),
  } as never);
  await chat.sendMessage("帮我装个包");
  return publisher;
}

describe("ChatService engine_paused 消费（审批闸接线批）", () => {
  test("approved → resume(approve)：ask 收到 command/reason，卡片链路复用", async () => {
    const ask = new StubAsk("approved");
    const engine = new GatedStubEngine(GATE_ARGS);
    await runOnce(engine, ask);
    expect(ask.requests).toEqual([
      { sessionId: expect.any(String), instanceId: "main", command: "bun install -g pkg", reason: "需要全局安装", kind: "permission_request" },
    ]);
    expect(engine.resumes).toEqual([{ pauseToken: "tok-1", decision: { kind: "approve" } }]);
  });

  test("auto_approved（提权自动通过）→ 同 resume(approve)：放行工具裸跑", async () => {
    const ask = new StubAsk("auto_approved");
    const engine = new GatedStubEngine(GATE_ARGS);
    await runOnce(engine, ask);
    expect(engine.resumes).toEqual([{ pauseToken: "tok-1", decision: { kind: "approve" } }]);
  });

  test("denied → resume(reject + 引导文案)", async () => {
    const ask = new StubAsk("denied");
    const engine = new GatedStubEngine(GATE_ARGS);
    await runOnce(engine, ask);
    expect(engine.resumes.length).toBe(1);
    const decision = engine.resumes[0]!.decision;
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.text).toContain("拒绝");
  });

  test("timeout → resume(reject + 超时文案)", async () => {
    const ask = new StubAsk("timeout");
    const engine = new GatedStubEngine(GATE_ARGS);
    await runOnce(engine, ask);
    const decision = engine.resumes[0]!.decision;
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.text).toContain("超时");
  });

  test("ask.request 异常（单 pending 冲突）→ resume(reject 防御文案)", async () => {
    const ask = new StubAsk("throw");
    const engine = new GatedStubEngine(GATE_ARGS);
    await runOnce(engine, ask);
    const decision = engine.resumes[0]!.decision;
    expect(decision.kind).toBe("reject");
  });

  test("无 ask 面（测试形态未注入）→ resume(reject 审批面不可用，不挂死)", async () => {
    const engine = new GatedStubEngine(GATE_ARGS);
    await runOnce(engine, undefined);
    const decision = engine.resumes[0]!.decision;
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.text).toContain("审批面");
  });

  test("args 形状防御：非 {command, reason} → resume(reject)，不发起 ask", async () => {
    const ask = new StubAsk("approved");
    const engine = new GatedStubEngine({ unexpected: true });
    await runOnce(engine, ask);
    expect(ask.requests.length).toBe(0);
    expect(engine.resumes[0]!.decision.kind).toBe("reject");
  });
});
