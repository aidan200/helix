import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { PROTOCOL_VERSION, type FrameVersion } from "@helix/protocol";
import type { Daemon } from "../../src/infrastructure/container";
import type { InstanceRunner, InstanceRunnerCallbacks, InstanceClosureOutcome } from "../../src/application/services/InstanceRunner";
import type { AgentEngineEvent } from "../../src/application/ports/outbound/AgentEnginePort";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";

/**
 * T2.3 WS 集成（test-design §4.3 GREEN 面 + F1.5 kill 链）：
 * - agent.* 事件经真实 WS 连接（integration 起 ws-server）可被订阅方收到：
 *   spawned→started→completed 完整序列，completed 携带五字段 ClosureDto
 *   （缺失字段显式 null），帧挂 instanceId；
 * - WS agent.kill → AgentOrchestrationPort → SchedulerService.kill →
 *   runner.kill（FB-3）→ agent.killed{closure failed}；
 * - kill 终态/未知实例 → connection.error 回执（中文说明）；agent.subscribe
 *   通路语义（记录不过滤，后续事件仍可达）。
 */

class KillableRunner implements InstanceRunner {
  private callbacks?: InstanceRunnerCallbacks;
  private readonly closed = new Set<string>();
  readonly kills: string[] = [];
  setCallbacks(cb: InstanceRunnerCallbacks): void {
    this.callbacks = cb;
  }
  launch(): void {
    // 挂起：closure 由测试驱动
  }
  send(): void {
    /* 本文件不覆盖 send */
  }
  kill(instanceId: string): void {
    this.kills.push(instanceId);
  }
  emitEngineEvent(instanceId: string, event: AgentEngineEvent): void {
    this.callbacks?.onInstanceEvent(instanceId, event);
  }
  forceClosure(instanceId: string, outcome: InstanceClosureOutcome): void {
    if (this.closed.has(instanceId)) return;
    this.closed.add(instanceId);
    this.callbacks?.onInstanceClosure(instanceId, outcome);
  }
}

/** 收集帧的 loopback WS 测试客户端（Bun 内建 WebSocket）。 */
class TestClient {
  readonly frames: { v: FrameVersion; type: string; instanceId?: string; payload: Record<string, unknown> }[] = [];
  private readonly ws: WebSocket;

  constructor(url: string, token: string) {
    this.ws = new WebSocket(url);
    this.ws.onopen = () => {
      this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "hello", payload: { token, protocolVersion: PROTOCOL_VERSION } }));
    };
    this.ws.onmessage = (ev: MessageEvent) => {
      this.frames.push(JSON.parse(String(ev.data)));
    };
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  async expect(type: string, timeoutMs = 5000): Promise<{ type: string; instanceId?: string; payload: Record<string, unknown> }> {
    await until(() => this.frames.some((f) => f.type === type), timeoutMs, `等待帧 ${type}（已收：${this.frames.map((f) => f.type).join(",")}）`);
    return this.frames.find((f) => f.type === type)!;
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) await this.ws.close();
  }
}

function until(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (cond()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`等待超时：${what}`));
      }
    }, 5);
  });
}

interface Rig {
  home: string;
  sessionId: string;
  runner: KillableRunner;
  daemon: Daemon;
  client: TestClient;
  dispose: () => Promise<void>;
}

async function makeRig(): Promise<Rig> {
  const home = mkdtempSync(path.join(tmpdir(), "helix-t23-ws-"));
  const engine = new FakeAgentEngine();
  const runner = new KillableRunner();
  const daemon = await createTestDaemon({
    home,
    engine,
    skipConfig: true,
    port: 0,
    subagentRunner: runner,
    cliInput: new PassThrough(),
    cliOutput: new PassThrough(),
    // D8 W-R3 后 cwd（主树/worktree）可能携带真实 kg 项目——绑定 tmp home 隔离
    //（任务切片注入零命中，TR-TEST-4 密闭性）。
    kgWorkspaceRoot: home,
  });
  const token = readFileSync(path.join(home, "dev-token"), "utf8").trim();
  const client = new TestClient(daemon.ws.url, token);
  // T4：握手命中零条目内存草稿（welcome.draft）时不 attach 不推快照——显式
  // session.subscribe 订阅当前会话（v0 兼容面）；真实会话握手维持现状。
  const welcome = await client.expect("connection.welcome", 3000);
  if (welcome.payload.draft === true) {
    client.send({ v: 0, type: "session.subscribe", payload: {} });
  }
  await client.expect("session.snapshot", 3000); // 握手通过（welcome + snapshot）
  return {
    home,
    sessionId: daemon.system.getStatus().sessionId,
    runner,
    daemon,
    client,
    dispose: async () => {
      await client.close();
      await daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

let current: Rig | undefined;
afterEach(async () => {
  if (current) {
    await current.dispose();
    current = undefined;
  }
});

describe("agent.* 事件经真实 WS 连接可被订阅方收到（契约 §5.1/§8.1）", () => {
  test("spawned → started → completed 序列 + completed 五字段 ClosureDto + 帧挂 instanceId", async () => {
    const rig = (current = await makeRig());

    const spawn1 = rig.daemon.orchestration.spawn("WS 序列验证任务");
    if (spawn1.status !== "run") throw new Error("unreachable");
    const agentId = spawn1.agentId; // T10a：agent-<唯一串>，捕获而非硬编码
    const spawned = await rig.client.expect("agent.spawned");
    expect(spawned.instanceId).toBe(agentId);
    expect(spawned.payload).toEqual({
      agentId,
      task: "WS 序列验证任务",
      profileKind: "subagent-worker",
      model: "anthropic/claude-sonnet-4-5", // T12：spawn 透传 = 两级链解析产物（槽位空 → 全局默认），恒在场
      anchorEntryId: null, // v0.3（T2.1 契约 §1 规则②）：流首 spawn（无任何 main entry）→ null
    });

    const started = await rig.client.expect("agent.started");
    expect(started.instanceId).toBe(agentId);
    expect(started.payload).toEqual({ agentId });

    rig.runner.forceClosure(agentId, {
      result: "done",
      closure: { status: "done", summary: "WS 序列任务完成", reportPath: null, findings: null, taskId: null },
    });
    const completed = await rig.client.expect("agent.completed");
    expect(completed.instanceId).toBe(agentId);
    // 五字段 ClosureDto（缺失字段显式 null）；reportPath 由 O-5 收口链填文件落点
    expect(completed.payload).toEqual({
      agentId,
      closure: {
        status: "done",
        summary: "WS 序列任务完成",
        reportPath: path.join(rig.home, "reports", rig.sessionId, `${agentId}.md`),
        findings: null,
        taskId: null,
      },
    });
  }, 10000);

  test("超限入队序列：spawned → queued{position} → （空位释放）started", async () => {
    const rig = (current = await makeRig());
    const placeholderIds: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const o = rig.daemon.orchestration.spawn(`占位任务${i}`);
      if (o.status !== "run") throw new Error("unreachable");
      placeholderIds.push(o.agentId); // T10a：agent-<唯一串>，捕获而非硬编码
    }
    await rig.client.expect("agent.started");

    const spawn4 = rig.daemon.orchestration.spawn("第 4 个（超限）");
    if (spawn4.status !== "queued") throw new Error("unreachable");
    const queuedId = spawn4.agentId;
    const queued = await rig.client.expect("agent.queued");
    expect(queued.instanceId).toBe(queuedId);
    expect(queued.payload).toEqual({ agentId: queuedId, position: 1 });

    // 空位释放 → 队首出队：queued 实例 started（卡片转 running；用谓词等待——缓冲区已有其他实例的 started 帧）
    rig.runner.forceClosure(placeholderIds[0]!, {
      result: "done",
      closure: { status: "done", summary: "占位完成", reportPath: null, findings: null, taskId: null },
    });
    await rig.client.expect("agent.completed");
    await until(
      () => rig.client.frames.some((f) => f.type === "agent.started" && f.instanceId === queuedId),
      5000,
      "等待超限实例出队 started",
    );
  }, 10000);

  test("SubAgent 工具事件帧挂 instanceId（per-instance 广播）；注入前主线零驱动", async () => {
    const rig = (current = await makeRig());
    const spawn1 = rig.daemon.orchestration.spawn("带工具任务");
    if (spawn1.status !== "run") throw new Error("unreachable");
    const agentId = spawn1.agentId; // T10a：agent-<唯一串>
    await rig.client.expect("agent.started");

    // SubAgent 内部工具事件上行 → tool.call.* 帧（挂 instanceId，广播不过滤）
    rig.runner.emitEngineEvent(agentId, {
      type: "tool_execution_start",
      toolCallId: "ws-sub-tc-1",
      toolName: "grep",
      args: { pattern: "x" },
    });
    const toolFrame = await rig.client.expect("tool.call.started");
    expect(toolFrame.instanceId).toBe(agentId);
    expect(toolFrame.payload).toMatchObject({ entry: { kind: "tool-call", id: "ws-sub-tc-1", name: "grep" } });

    // 工具事件不驱动主线（无 chat.turn.started/无主线 delta）——注入尚未发生
    expect(rig.client.frames.filter((f) => f.type === "chat.turn.started")).toEqual([]);
    expect(rig.client.frames.filter((f) => f.type === "chat.stream.delta")).toEqual([]);

    // closure 注入才驱动主线新 turn（双通道分工：工具事件 per-instance、closure 进主线）
    rig.runner.forceClosure(agentId, {
      result: "done",
      closure: { status: "done", summary: "ok", reportPath: null, findings: null, taskId: null },
    });
    await rig.client.expect("agent.completed");
    await rig.client.expect("chat.turn.started");
  }, 10000);
});

describe("kill 命令链：WS agent.kill → port → SchedulerService.kill → runner（O-6）", () => {
  test("kill 正常路径 → agent.killed{closure failed}；FB-3 runner.kill 收到终止信号", async () => {
    const rig = (current = await makeRig());
    const spawn1 = rig.daemon.orchestration.spawn("待终止任务");
    if (spawn1.status !== "run") throw new Error("unreachable");
    const agentId = spawn1.agentId; // T10a：agent-<唯一串>
    await rig.client.expect("agent.started");

    rig.client.send({ v: 0, type: "agent.kill", payload: { agentId } });
    const killed = await rig.client.expect("agent.killed");
    expect(killed.instanceId).toBe(agentId);
    const closure = killed.payload["closure"] as Record<string, unknown>;
    expect(closure["status"]).toBe("failed"); // 单一终态（契约 §8-2）
    expect(closure["summary"]).toBe("已由用户终止（kill）");
    expect(String(closure["reportPath"])).toMatch(/reports\/.*agent-[0-9a-f]+\.md$/); // kill 也产报告
    expect(closure["findings"]).toBeNull();
    expect(closure["taskId"]).toBeNull();
    expect(rig.runner.kills).toEqual([agentId]); // FB-3：子进程终止信号已发
  }, 10000);

  test("kill 终态实例/未知实例 → connection.error 回执（中文说明，连接保持）", async () => {
    const rig = (current = await makeRig());
    const spawn1 = rig.daemon.orchestration.spawn("会先收口的任务");
    if (spawn1.status !== "run") throw new Error("unreachable");
    const agentId = spawn1.agentId; // T10a：agent-<唯一串>
    await rig.client.expect("agent.started");
    rig.runner.forceClosure(agentId, {
      result: "done",
      closure: { status: "done", summary: "ok", reportPath: null, findings: null, taskId: null },
    });
    await rig.client.expect("agent.completed");

    const before = rig.client.frames.length;
    rig.client.send({ v: 0, type: "agent.kill", payload: { agentId } }); // 已终态
    rig.client.send({ v: 0, type: "agent.kill", payload: { agentId: "agent-404" } }); // 不存在
    const collected: { type: string; payload: { code: string; message: string } }[] = [];
    await until(
      () => {
        for (const f of rig.client.frames.slice(before)) {
          if (f.type === "connection.error" && !collected.includes(f as never)) {
            collected.push(f as unknown as { type: string; payload: { code: string; message: string } });
          }
        }
        return collected.length >= 2;
      },
      5000,
      "等待两条 connection.error 回执",
    );
    expect(collected[0]!.payload.message).toContain("已终态");
    expect(collected[1]!.payload.message).toContain("不存在");
    for (const f of collected) expect(f.payload.code).toBe("command.invalid_payload");
  }, 10000);

  test("agent.subscribe 通路语义：登记不过滤——订阅后其他实例事件仍广播可达", async () => {
    const rig = (current = await makeRig());
    // 先 spawn 拿到真实实例 id（T10a：agent-<唯一串>），再订阅——订阅登记不过滤
    const spawn1 = rig.daemon.orchestration.spawn("实例 A");
    if (spawn1.status !== "run") throw new Error("unreachable");
    const agentId = spawn1.agentId;
    rig.client.send({ v: 0, type: "agent.subscribe", payload: { agentId } });
    await new Promise((r) => setTimeout(r, 50)); // 命令帧往返

    await rig.client.expect("agent.spawned");
    rig.runner.forceClosure(agentId, {
      result: "done",
      closure: { status: "done", summary: "A 完成", reportPath: null, findings: null, taskId: null },
    });
    // 订阅的是该实例，其事件可达；无 connection.error（通路语义不拒绝）
    await rig.client.expect("agent.completed");
    expect(rig.client.frames.filter((f) => f.type === "connection.error")).toEqual([]);

    // 退订同构（登记移除，不关连接）
    rig.client.send({ v: 0, type: "agent.unsubscribe", payload: { agentId } });
    await new Promise((r) => setTimeout(r, 50));
    rig.daemon.orchestration.spawn("实例 B");
    await until(
      () => rig.client.frames.filter((f) => f.type === "agent.spawned").length >= 2,
      5000,
      "等待实例 B spawned 帧",
    ); // 连接仍活、广播仍达
  }, 10000);
});
