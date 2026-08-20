import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createDaemon, type Daemon } from "../../src/infrastructure/container";
import type {
  InstanceRunner,
  InstanceRunnerCallbacks,
  InstanceClosureOutcome,
} from "../../src/application/services/InstanceRunner";
import type { AgentEngineEvent } from "../../src/application/ports/outbound/AgentEnginePort";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { SessionProjection } from "../../src/application/services/SessionProjection";
import { Session } from "../../src/domain/session/Session";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import { InMemorySessionRepository } from "../mocks/InMemorySessionRepository";
import { PROTOCOL_VERSION, type FrameVersion } from "@helix/protocol";

/**
 * T2.1 RED（AD-3 统一信封路由 + 会话投影，test-design §2 CL-4 / F(4.0).5）：
 *
 * ① 投影消费扩面：SubAgent thinking 累积 / message 落树（message_update 流式
 *    转发）/ tool 记录——经事件总线由会话投影消费者落 Session 聚合（Entry
 *    instanceId 归属 agent-N）+ write-through 触发（落库计数断言）；
 * ② SchedulerService 职责回归守护：源码对 Session 聚合写方法调用为零
 *    （test-design §6 ① 静态 grep 断言）；
 * ③ DtoMapper/RowMapper instanceId 行级透传 + 恢复读面重放含 SubAgent 历史
 *    （重启后快照 instances[].channels / toolCalls 含过程历史）；
 * ④ WS 统一信封路由：帧全量 sessionId + channel 章印；session.subscribe 按
 *    会话订阅（unsubscribe 后停收 / subscribe 重推快照）；
 * ⑤ 投影幂等：同事件重放不重复落树（沿「重放幂等」纪律）。
 */

/** 剧本 SubAgent runner：FakeAgentEngine 驱动，引擎事件全量上行 + 可控收口。 */
class ScriptedSubagentRunner implements InstanceRunner {
  private callbacks?: InstanceRunnerCallbacks;
  readonly launched: { instanceId: string; task: string }[] = [];

  setCallbacks(callbacks: InstanceRunnerCallbacks): void {
    this.callbacks = callbacks;
  }

  launch(instance: { instanceId: string }, task: string): void {
    this.launched.push({ instanceId: instance.instanceId, task });
    void (async () => {
      const engine = new FakeAgentEngine({
        replies: [
          {
            thinking: "调研事件分发架构……",
            text: "SubAgent 结论：事件总线是唯一事实源。",
            usage: { input: 100, output: 20, reasoning: 4 },
            toolCalls: [{ toolName: "grep", args: { pattern: "AD-3" }, result: "container.ts:151" }],
          },
        ],
      });
      const forward = (e: AgentEngineEvent) => this.callbacks?.onInstanceEvent(instance.instanceId, e);
      await engine.start(task, forward);
      this.callbacks?.onInstanceClosure(instance.instanceId, {
        result: "done",
        closure: { status: "done", summary: `${task} 完成`, reportPath: null, findings: null, taskId: null },
      });
    })();
  }
}

interface Rig {
  home: string;
  sessionId: string;
  runner: ScriptedSubagentRunner;
  daemon: Daemon;
  dispose: () => Promise<void>;
}

let current: Rig | undefined;
afterEach(async () => {
  const rig = current;
  current = undefined;
  if (rig) await rig.dispose();
});

async function makeRig(): Promise<Rig> {
  const home = mkdtempSync(path.join(tmpdir(), "helix-t21-projection-"));
  const engine = new FakeAgentEngine({ replies: [{ text: "主线回复（完）" }] });
  const runner = new ScriptedSubagentRunner();
  const daemon = await createDaemon({
    home,
    engine,
    skipConfig: true,
    port: 0,
    subagentRunner: runner,
    cliInput: new PassThrough(),
    cliOutput: new PassThrough(),
  });
  const rig: Rig = {
    home,
    sessionId: daemon.system.getStatus().sessionId,
    runner,
    daemon,
    dispose: async () => {
      await daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
    },
  };
  current = rig;
  return rig;
}

function until(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (cond()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`until 超时：${label}（${timeoutMs}ms）`));
      }
    }, 5);
  });
}

// ── ① 投影消费扩面：SubAgent Entry 进聚合 + write-through ─────────────

describe("T2.1 ① 会话投影：SubAgent thinking/message/tool 进聚合（instanceId 归属）", () => {
  test("spawn 完成后聚合含 instanceId=agent-N 的三类条目；落库快照同构；主线时间轴不被污染", async () => {
    const rig = await makeRig();
    const outcome = rig.daemon.orchestration.spawn("调研事件分发");
    expect(outcome.status).toBe("run");
    await until(() => rig.daemon.orchestration.status("agent-1")![0]!.state === "done", 5000, "SubAgent 收口");

    // 聚合：thinking + message Entry（instanceId 归属 agent-1）
    const snapshot = rig.daemon.session.getSnapshot();
    const subEntries = snapshot.session.entries.filter((e) => e.instanceId === "agent-1");
    const kinds = subEntries.map((e) => ("kind" in e ? e.kind : "message"));
    expect(kinds).toContain("message");
    expect(kinds).toContain("thinking");
    const message = subEntries.find((e) => "kind" in e === false) as { text: string } | undefined;
    expect(message?.text).toContain("事件总线是唯一事实源");
    const thinking = subEntries.find((e) => "kind" in e && e.kind === "thinking");
    expect(thinking && "text" in thinking ? thinking.text : "").toContain("调研事件分发架构");

    // 工具记录：SubAgent 工具进 toolCalls（instanceId 行级归属）
    const subTool = snapshot.toolCalls.find((t) => t.id.includes("grep") || t.toolName === "grep");
    expect(subTool).toBeDefined();
    expect(subTool!.instanceId).toBe("agent-1");
    expect(subTool!.status).toBe("completed");

    // MainAgent 上下文零混入：SubAgent 条目不挂主线 turn（turnId=null；
    // closure 注入 SteerQueue 是唯一入口——SubAgent 收口后主线新 turn 属 AD-8
    // 双通道合法行为，不在此断言面）
    const subMessages = subEntries.filter((e): e is Extract<(typeof subEntries)[number], { turnId: unknown }> => "turnId" in e);
    expect(subMessages.every((e) => e.turnId === null)).toBe(true);
    expect(snapshot.session.entries.every((e) => e.instanceId !== undefined)).toBe(true);
  }, 15000);
});

// ── ② SchedulerService 职责回归守护（零聚合写） ─────────────────────

describe("T2.1 ② SchedulerService 零聚合写守护（test-design §6 ①）", () => {
  test("源码对 Session 聚合写方法调用为零 + 不 import Session 聚合", async () => {
    const source = await Bun.file(
      path.resolve(import.meta.dir, "../../src/application/services/SchedulerService.ts"),
    ).text();
    // 聚合写方法调用零（grep 断言；注释中的方法名不以「(」紧跟调用形态出现）
    const aggregateWriteCalls = source.match(
      /\.(pushEntry|appendUserEntry|appendAssistantEntry|appendThinkingEntry|appendCompactionEntry|appendInstanceMessage|reserveEntryId|beginTurn|applySteer|completeTurn|interruptTurn)\s*\(/g,
    );
    expect(aggregateWriteCalls).toBeNull();
    expect(source).not.toMatch(/from\s+"[^"]*domain\/session\/Session"/);
    // SubAgent 事件经事件总线：publish 通路在场（onInstanceEvent 只产事件）
    expect(source).toContain("this.publish(instance");
  });
});

// ── ③ instanceId 行级透传 + 恢复读面重放含 SubAgent 历史 ─────────────

describe("T2.1 ③ 恢复重放含 SubAgent 历史（重启后快照/抽屉读面）", () => {
  test("重启后快照 entries/toolCalls/instances[].channels 含 SubAgent 过程历史", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-t21-restore-"));
    const mk = async (): Promise<Daemon> => {
      const engine = new FakeAgentEngine({ replies: [{ text: "主线回复（完）" }] });
      return createDaemon({
        home,
        engine,
        skipConfig: true,
        port: 0,
        subagentRunner: new ScriptedSubagentRunner(),
        cliInput: new PassThrough(),
        cliOutput: new PassThrough(),
      });
    };
    const d1 = await mk();
    const sessionId = d1.system.getStatus().sessionId;
    d1.orchestration.spawn("调研事件分发");
    await until(() => d1.orchestration.status("agent-1")![0]!.state === "done", 5000, "SubAgent 收口");
    await d1.shutdown();

    const d2 = await mk();
    try {
      expect(d2.system.getStatus().sessionId).toBe(sessionId);
      const snapshot = d2.session.getSnapshot();
      // 恢复读面：SubAgent 历史 Entry 在场（instanceId 归属正确）
      const subEntries = snapshot.session.entries.filter((e) => e.instanceId === "agent-1");
      expect(subEntries.map((e) => ("kind" in e ? e.kind : "message")).sort()).toEqual(["message", "thinking"]);
      // 工具记录恢复（instanceId 行级透传往返）
      const subTool = snapshot.toolCalls.find((t) => t.toolName === "grep");
      expect(subTool?.instanceId).toBe("agent-1");
      expect(subTool?.status).toBe("completed");
      // 实例清单恢复（卡片骨架）+ 账目恢复（usage.recorded 事件重放）
      expect(snapshot.instances?.some((i) => i.instanceId === "agent-1" && i.state === "done")).toBe(true);
      expect(snapshot.usage?.total.input ?? 0).toBeGreaterThanOrEqual(100);
    } finally {
      await d2.shutdown();
      rmSync(home, { recursive: true, force: true });
    }
  }, 90000);

  test("快照 DTO instances[].channels 反映 SubAgent 同构内容（AD-1 分组）", async () => {
    const { toSnapshotDto } = await import("../../src/adapters/driving/ws-server/DtoMapper");
    const rig = await makeRig();
    rig.daemon.orchestration.spawn("调研事件分发");
    await until(() => rig.daemon.orchestration.status("agent-1")![0]!.state === "done", 5000, "SubAgent 收口");
    const dto = toSnapshotDto(rig.daemon.session.getSnapshot(), "fake/model", "idle");
    const agent = dto.instances?.find((i) => i.instanceId === "agent-1");
    expect(agent).toBeDefined();
    expect(agent!.channels?.messages?.length).toBe(1);
    const subMessageDto = agent!.channels?.messages?.[0];
    expect(subMessageDto?.kind).toBe("message");
    if (subMessageDto?.kind === "message") {
      expect(subMessageDto.content).toContain("事件总线是唯一事实源");
    }
    expect(agent!.channels?.thinking?.length).toBe(1);
    expect(agent!.channels?.tools?.length).toBe(1);
    expect(agent!.channels?.tools?.[0]).toMatchObject({ kind: "tool-call", name: "grep" });
    // 主实例条目不带 channels（主时间轴 entries 即主实例历史）
    const main = dto.instances?.find((i) => i.instanceId === "main");
    expect(main?.channels).toBeUndefined();
    // T2.2（AD-1 尾窗口径）：主时间轴 entries 只含主实例条目——SubAgent
    // 消息不进主轴（per-instance channels 完整保留，不按全局时间序切尾）
    const subMessage = dto.entries.find((e) => e.kind === "message" && e.instanceId === "agent-1");
    expect(subMessage).toBeUndefined();
  }, 15000);
});

// ── ④ WS 统一信封路由 ───────────────────────────────────────────

/** 收集帧的 loopback WS 测试客户端。 */
class WsClient {
  readonly frames: {
    v: FrameVersion;
    type: string;
    channel?: string;
    sessionId?: string;
    instanceId?: string;
    payload: Record<string, unknown>;
  }[] = [];
  private readonly ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev: MessageEvent) => {
      this.frames.push(JSON.parse(String(ev.data)));
    };
  }

  async open(timeoutMs = 3000): Promise<void> {
    await until(() => this.ws.readyState === WebSocket.OPEN, timeoutMs, "WS 连接建立");
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  async expect(type: string, timeoutMs = 3000): Promise<(typeof this.frames)[number]> {
    await until(() => this.frames.some((f) => f.type === type), timeoutMs, `等待帧 ${type}`);
    return this.frames.find((f) => f.type === type)!;
  }

  /** 等待 afterIndex 之后出现的首个指定 type 帧（新旧帧区分）。 */
  async expectAfter(type: string, afterIndex: number, timeoutMs = 3000): Promise<(typeof this.frames)[number]> {
    await until(
      () => client_framesAfter(this, afterIndex).some((f) => f.type === type),
      timeoutMs,
      `等待新帧 ${type}`,
    );
    return client_framesAfter(this, afterIndex).find((f) => f.type === type)!;
  }

  async close(): Promise<void> {
    this.ws.close();
    await until(() => this.ws.readyState === WebSocket.CLOSED, 1000, "WS 关闭");
  }
}

describe("T2.1 ④ WS 统一信封：sessionId/channel 全量章印 + 按会话订阅", () => {
  test("真 token 握手：事件帧 sessionId+channel 章印；unsubscribe 停收 → subscribe 重推快照", async () => {
    const rig = await makeRig();
    const token = (await (await fetch(`http://127.0.0.1:${rig.daemon.ws.port}/helix-dev-token`)).text()).trim();
    const client = new WsClient(rig.daemon.ws.url);
    try {
      await client.open();
      client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token, protocolVersion: PROTOCOL_VERSION } });
      const welcome = await client.expect("connection.welcome");
      // T4：零条目草稿握手不 attach 不推快照——显式订阅当前会话（v0 兼容面）
      if (welcome.payload.draft === true) {
        client.send({ v: 0, type: "session.subscribe", payload: {} });
      }
      const snap = await client.expect("session.snapshot");
      expect(snap.sessionId).toBe(rig.sessionId);
      expect(snap.channel).toBe("session");

      // 订阅中：SubAgent 运行 → 帧全量章印
      rig.daemon.orchestration.spawn("调研事件分发");
      const spawned = await client.expect("agent.spawned");
      expect(spawned.sessionId).toBe(rig.sessionId);
      expect(spawned.channel).toBe("agent");
      expect(spawned.instanceId).toBe("agent-1");
      const stream = await client.expect("chat.stream.delta");
      expect(stream.sessionId).toBe(rig.sessionId);
      expect(stream.channel).toBe("chat");
      expect(stream.instanceId).toBe("agent-1");
      const think = await client.expect("thinking.stream.delta");
      expect(think.channel).toBe("thinking");
      expect(think.instanceId).toBe("agent-1");
      const completed = await client.expect("chat.message.completed");
      expect(completed.channel).toBe("chat");
      const tool = await client.expect("tool.call.result");
      expect(tool.channel).toBe("chat");
      expect(tool.instanceId).toBe("agent-1");
      await client.expect("agent.completed");

      // closure 注入驱动的后续主线 turn（agent.completed 后自动开启）收口后再取
      // baseline——否则在飞帧与 baseline 竞态（既有 flake 根因：退订前合法帧
      // 被计入退订后断言窗口）。切片基准 = agent.completed 帧下标（非事后采样
      // frames.length——负载下 idle 帧可能先于采样到达，落入前缀永等不到，
      // 2026-08-18 OI-DEV-1 根治）
      const completedIdx = client.frames.map((f) => f.type).lastIndexOf("agent.completed"); // es2022 lib 无 findLastIndex（OI-DEV-1 收口：等价语义零行为变更）
      try {
        await until(
          () =>
            client.frames.slice(completedIdx + 1).some(
              (f) => f.type === "agent.state.changed" && (f.payload as { state?: string }).state === "idle",
            ),
          15000,
          "closure 注入 turn 收口",
        );
      } catch (err) {
        // 超时诊断：dump completed 帧之后的帧序列（OI-DEV-1 排查面）
        console.log(
          "closure 收口超时帧诊断:",
          client.frames
            .slice(completedIdx + 1)
            .map((f) => `${f.type}${(f.payload as { state?: string }).state ? `:${(f.payload as { state?: string }).state}` : ""}`),
        );
        throw err;
      }

      // per-session 退订（v0 兼容：不带信封 sessionId = 当前单会话）→ 停收
      const baseline = client.frames.length;
      client.send({ v: 0, type: "session.unsubscribe", payload: {} });
      await new Promise((r) => setTimeout(r, 150));
      rig.daemon.orchestration.spawn("第二个任务");
      await new Promise((r) => setTimeout(r, 400));
      // T2.2（AD-4）：退订后该会话事件帧停收；session.list_changed 是 daemon
      // 级清单广播（SYSTEM_SESSION_ID，与连接订阅集无关）仍可达
      const after = client.frames.slice(baseline).filter((f) => f.type !== "session.list_changed");
      expect(after).toEqual([]);

      // 重订 → 快照重推（含 SubAgent 历史）
      client.send({ v: PROTOCOL_VERSION, type: "session.subscribe", payload: {}, sessionId: rig.sessionId });
      const snap2 = await client.expectAfter("session.snapshot", baseline);
      expect(snap2.sessionId).toBe(rig.sessionId);
      // T2.2（AD-1）：SubAgent 历史在 per-instance channels（主轴尾窗不含）
      const snapshot2 = snap2.payload.snapshot as {
        entries: { instanceId?: string }[];
        instances?: { instanceId: string; channels?: { messages?: unknown[] } }[];
      };
      expect(snapshot2.entries.some((e) => e.instanceId === "agent-1")).toBe(false);
      expect(snapshot2.instances?.find((i) => i.instanceId === "agent-1")?.channels?.messages?.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  }, 90000);
});

// ── ⑤ 投影幂等（同事件重放不重复落树） ─────────────────────────────

describe("T2.1 ⑤ 投影幂等：同事件重放不重复落树", () => {
  test("同一 thinking.completed/message.completed/tool 事件重放两次，聚合/记录不重复", async () => {
    const repository = new InMemorySessionRepository();
    const session = Session.create("s-t21-idem", new Date(0).toISOString());
    const projection = new SessionProjection({
      repository,
      getSession: () => session,
      getMainState: () => ({ agentState: "idle", toolCalls: [] }),
    });
    const occurredAt = new Date(1000).toISOString();
    const thinkingEvent = {
      type: "thinking.completed",
      sessionId: "s-t21-idem",
      instanceId: "agent-1",
      payload: {
        entry: {
          kind: "thinking" as const,
          id: "agent-1#1",
          instanceId: "agent-1",
          text: "思考内容",
          durationMs: 5,
          reasoningTokens: 3,
          createdAt: occurredAt,
        },
      },
      occurredAt,
    } satisfies DomainEvent;
    const messageEvent = {
      type: "message.completed",
      sessionId: "s-t21-idem",
      instanceId: "agent-1",
      payload: { entryId: "agent-1#2", role: "assistant" as const, text: "回复内容", isSteer: false },
      occurredAt,
    } satisfies DomainEvent;
    const toolStart = {
      type: "tool.call.started",
      sessionId: "s-t21-idem",
      instanceId: "agent-1",
      payload: { toolCallId: "tc-1", toolName: "grep", args: { pattern: "x" } },
      occurredAt,
    } satisfies DomainEvent;
    const toolResult = {
      type: "tool.call.result",
      sessionId: "s-t21-idem",
      instanceId: "agent-1",
      payload: { toolCallId: "tc-1", toolName: "grep", args: { pattern: "x" }, isError: false, result: "命中" },
      occurredAt,
    } satisfies DomainEvent;
    // 重放两轮（幂等判据：第二轮零追加）
    for (let round = 0; round < 2; round++) {
      projection.publish(thinkingEvent);
      projection.publish(messageEvent);
      projection.publish(toolStart);
      projection.publish(toolResult);
    }
    const entries = session.entryList().filter((e) => e.instanceId === "agent-1");
    expect(entries).toHaveLength(2);
    const persisted = await repository.restore("s-t21-idem");
    expect(persisted?.session.entries.filter((e) => e.instanceId === "agent-1")).toHaveLength(2);
    expect(persisted?.toolCalls.filter((t) => t.instanceId === "agent-1")).toHaveLength(1);
  });
});

// 挂起句柄防泄漏（makeRig 的 afterEach 之外自管 home 的用例已内联清理）
function client_framesAfter(client: WsClient, afterIndex: number) {
  return client.frames.slice(afterIndex);
}
