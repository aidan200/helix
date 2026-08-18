import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createDaemon, type Daemon } from "../../src/infrastructure/container";
import { PROTOCOL_VERSION, type FrameVersion } from "@helix/protocol";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import type {
  InstanceRunner,
  InstanceRunnerCallbacks,
  InstanceClosureOutcome,
} from "../../src/application/services/InstanceRunner";

/**
 * TP-CL3-2 / TP-CL3-3（I 半）：chat.steer 定向路由（契约 v0.3 §3.2，AD-5/Q-3a）。
 * - 定向注入剧本：steer 指定运行中实例 → 主轴落 isSteer Entry（instanceId=目标）
 *   + steer.queued 帧信封挂 instanceId（channel=chat，session 订阅面）
 *   + AgentOrchestrationPort.send 链投递（runner.send 实收）；
 * - 恢复重放：注入后重启 → 干预历史完整（主轴尾窗 + 实例 channel 双处可见）；
 * - 非运行中回执：unknown/completed/queued 目标 → connection.error 点对点回执
 *   （TR-AD-21，同 agent.kill 形态；T2.3 裁决码 command.invalid_payload）
 *   + 零 Entry 零投递；
 * - 缺省路径回归由既有「运行中 chat.steer → steer.queued」（ws-server.test.ts）
 *   与单测 ⑦-3 钉死（本文件不重复剧本）。
 */

/** 帧收集客户端（loopback；与 ws-server.test.ts TestClient 同构最小集）。 */
interface Frame {
  v: FrameVersion;
  type: string;
  payload: Record<string, unknown>;
  sessionId?: string;
  channel?: string;
  instanceId?: string;
}

class TestClient {
  readonly frames: Frame[] = [];
  private readonly ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev: MessageEvent) => {
      this.frames.push(JSON.parse(String(ev.data)) as Frame);
    };
  }

  async open(timeoutMs = 3000): Promise<void> {
    await until(() => this.ws.readyState === WebSocket.OPEN, timeoutMs, "WS 连接建立");
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  async expect(type: string, timeoutMs = 3000): Promise<Frame> {
    await until(() => this.frames.some((f) => f.type === type), timeoutMs, `等待帧 ${type}（已收：${this.frames.map((f) => f.type).join(",")}）`);
    return this.frames.find((f) => f.type === type)!;
  }

  async waitFor(pred: (f: Frame) => boolean, what: string, timeoutMs = 3000): Promise<Frame> {
    await until(() => this.frames.some(pred), timeoutMs, `等待帧（${what}；已收：${this.frames.map((f) => f.type).join(",")}）`);
    return this.frames.find(pred)!;
  }

  async close(): Promise<void> {
    this.ws.close();
  }
}

/** 挂起语义 runner + send 录音（launch 记录 + 收口由测试显式驱动）。 */
class SendingRunner implements InstanceRunner {
  private callbacks?: InstanceRunnerCallbacks;
  readonly launched: string[] = [];
  readonly sent: { instanceId: string; text: string }[] = [];
  setCallbacks(callbacks: InstanceRunnerCallbacks): void {
    this.callbacks = callbacks;
  }
  launch(instance: { instanceId: string }): void {
    this.launched.push(instance.instanceId);
  }
  send(instanceId: string, text: string): void {
    this.sent.push({ instanceId, text });
  }
  forceClosure(instanceId: string, outcome: InstanceClosureOutcome): void {
    this.callbacks?.onInstanceClosure(instanceId, outcome);
  }
}

async function until(cond: () => boolean, timeoutMs = 2000, what = "条件成立"): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`until 超时（${timeoutMs}ms）：${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function tmpHome(): string {
  return mkdtempSync(path.join(tmpdir(), "helix-t23-steer-"));
}

interface Rig {
  home: string;
  daemon: Daemon;
  runner: SendingRunner;
  token: string;
  url: string;
}

async function makeRig(home: string): Promise<Rig> {
  const engine = new FakeAgentEngine();
  const runner = new SendingRunner();
  const daemon = await createDaemon({
    home,
    engine,
    skipConfig: true,
    port: 0,
    subagentRunner: runner,
    cliInput: new PassThrough(),
    cliOutput: new PassThrough(),
  });
  const token = readFileSync(path.join(home, "dev-token"), "utf8");
  return { home, daemon, runner, token, url: `ws://127.0.0.1:${daemon.ws.port}` };
}

function hello(token: string): unknown {
  return { v: PROTOCOL_VERSION, type: "hello", payload: { token, protocolVersion: PROTOCOL_VERSION } };
}

function snapshotOf(frame: Frame): { entries: Record<string, unknown>[]; instances?: Record<string, unknown>[] } {
  return (frame.payload as { snapshot: { entries: Record<string, unknown>[]; instances?: Record<string, unknown>[] } }).snapshot;
}

/** 重推快照（session.subscribe 幂等语义：订阅即重推全量快照）。 */
async function refetchSnapshot(client: TestClient, sessionId: string): Promise<Frame> {
  const before = client.frames.length;
  client.send({ v: PROTOCOL_VERSION, type: "session.subscribe", sessionId, payload: {} });
  await until(() => client.frames.slice(before).some((f) => f.type === "session.snapshot"), 3000, "重推快照");
  return client.frames.slice(before).find((f) => f.type === "session.snapshot")!;
}

describe("TP-CL3-2/3：chat.steer 定向路由（契约 v0.3 §3.2）", () => {
  test("定向注入剧本：落 Entry + steer.queued 挂 instanceId + send 链投递 + 快照双处可见", async () => {
    const home = tmpHome();
    const rig = await makeRig(home);
    const client = new TestClient(rig.url);
    try {
      await client.open();
      client.send(hello(rig.token));
      const snap0 = await client.expect("session.snapshot");
      const sessionId = snap0.sessionId!;

      //  spawn 一个运行中 SubAgent（调度链真体 + 挂起 runner）
      const spawned = rig.daemon.orchestration.spawn("子代理任务");
      expect(spawned.status).toBe("run");
      const agentId = (spawned as { agentId: string }).agentId;

      client.send({
        v: PROTOCOL_VERSION,
        type: "chat.steer",
        sessionId,
        payload: { text: "改用保守方案", instanceId: agentId },
      });

      // ③ steer.queued 帧：信封挂 instanceId=目标 + channel=chat（session 订阅面）
      const queued = await client.waitFor(
        (f) => f.type === "steer.queued" && f.instanceId === agentId,
        "定向 steer.queued（信封挂 instanceId）",
      );
      expect(queued.channel).toBe("chat");
      const entryId = (queued.payload as { entryId: string }).entryId;
      expect(typeof entryId).toBe("string");

      // ② AgentOrchestrationPort.send 链投递证据（runner.send 实收同参）
      expect(rig.runner.sent).toEqual([{ instanceId: agentId, text: "改用保守方案" }]);

      // ① 主轴落 Entry（domain 聚合直读：user + isSteer + instanceId=目标）
      const domainEntry = rig.daemon.session
        .getSnapshot()
        .session.entries.find((e) => "role" in e && e.id === entryId);
      expect(domainEntry).toMatchObject({ role: "user", text: "改用保守方案", isSteer: true, instanceId: agentId });

      // 双处可见数据面（快照 DTO）：主轴尾窗含定向细条 + 实例 channel messages 含同 entry
      const snapFrame = await refetchSnapshot(client, sessionId);
      const snap = snapshotOf(snapFrame);
      const mainAxisEntry = snap.entries.find((e) => e["id"] === entryId);
      expect(mainAxisEntry).toMatchObject({ kind: "message", role: "user", instanceId: agentId });
      expect(typeof mainAxisEntry!["steerState"]).toBe("string"); // isSteer 条目携带 steer 态
      const instance = snap.instances?.find((i) => i["instanceId"] === agentId);
      const channelMessages = (instance?.["channels"] as { messages?: Record<string, unknown>[] } | undefined)?.messages ?? [];
      expect(channelMessages.some((m) => m["id"] === entryId)).toBe(true);
    } finally {
      await client.close();
      await rig.daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
    }
  }, 15000);

  test("恢复重放：定向干预重启后完整（主轴尾窗 + 实例 channel 双处可见）", async () => {
    const home = tmpHome();
    const rig1 = await makeRig(home);
    const spawned = rig1.daemon.orchestration.spawn("会被重启打断的任务");
    const agentId = (spawned as { agentId: string }).agentId;
    // 经会话路由面定向注入（chatRouter → ChatService → send 链）
    await rig1.daemon.chat.steer("重启前注入的干预", undefined, agentId);
    expect(rig1.runner.sent).toEqual([{ instanceId: agentId, text: "重启前注入的干预" }]);
    await rig1.daemon.shutdown();

    // 重启（同 home；运行中实例按 AD-10 收口 failed——与干预历史断言无关）
    const rig2 = await makeRig(home);
    const client = new TestClient(rig2.url);
    try {
      await client.open();
      client.send(hello(rig2.token));
      const snapFrame = await client.expect("session.snapshot");
      const snap = snapshotOf(snapFrame);
      // 主轴：干预 entry 完整重放（isSteer + 目标 instanceId）
      const replayed = snap.entries.find(
        (e) => e["role"] === "user" && e["content"] === "重启前注入的干预",
      );
      expect(replayed).toMatchObject({ kind: "message", instanceId: agentId });
      expect(typeof replayed!["steerState"]).toBe("string");
      // 抽屉侧：实例 channel messages 同 entry 重放
      const instance = snap.instances?.find((i) => i["instanceId"] === agentId);
      const channelMessages = (instance?.["channels"] as { messages?: Record<string, unknown>[] } | undefined)?.messages ?? [];
      expect(channelMessages.some((m) => m["content"] === "重启前注入的干预")).toBe(true);
    } finally {
      await client.close();
      await rig2.daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
    }
  }, 15000);

  test("非运行中实例回执：unknown/completed/queued → connection.error 点对点 + 零 Entry 零投递", async () => {
    const home = tmpHome();
    const rig = await makeRig(home);
    const client = new TestClient(rig.url);
    try {
      await client.open();
      client.send(hello(rig.token));
      const snap0 = await client.expect("session.snapshot");
      const sessionId = snap0.sessionId!;

      const steerTo = (instanceId: string, text: string) =>
        client.send({ v: PROTOCOL_VERSION, type: "chat.steer", sessionId, payload: { text, instanceId } });
      const expectSteerError = async (hint: string): Promise<Frame> => {
        const before = client.frames.length;
        const frame = await client.waitFor(
          (f) => f.type === "connection.error" && client.frames.indexOf(f) >= before,
          `connection.error（${hint}）`,
        );
        expect(frame.channel).toBe("notification");
        expect((frame.payload as { code: string }).code).toBe("command.invalid_payload");
        expect((frame.payload as { message: string }).message).toContain("chat.steer");
        return frame;
      };

      // unknown 目标
      steerTo("agent-99", "给不存在实例");
      const errUnknown = await expectSteerError("unknown");
      expect((errUnknown.payload as { message: string }).message).toContain("不存在");

      // completed 目标（spawn → 强制自然收口）
      const s1 = rig.daemon.orchestration.spawn("将完成的任务");
      const doneId = (s1 as { agentId: string }).agentId;
      rig.runner.forceClosure(doneId, {
        result: "done",
        closure: { status: "done", summary: "已完成" },
      });
      steerTo(doneId, "给已收口实例");
      const errDone = await expectSteerError("completed");
      expect((errDone.payload as { message: string }).message).toContain("已终态");

      // queued 目标（占满 maxConcurrent=3 后第 4 个入队；前序 completed 已释放一席）
      rig.daemon.orchestration.spawn("占用一");
      rig.daemon.orchestration.spawn("占用二");
      rig.daemon.orchestration.spawn("占用三");
      const s4 = rig.daemon.orchestration.spawn("排队中的任务");
      expect(s4.status).toBe("queued");
      const queuedId = (s4 as { agentId: string }).agentId;
      steerTo(queuedId, "给排队实例");
      const errQueued = await expectSteerError("queued");
      expect((errQueued.payload as { message: string }).message).toContain("排队中");

      // 零 Entry 零投递：三次定向尝试均未落账、runner.send 零调用、零 steer.queued
      await new Promise((r) => setTimeout(r, 50)); // 让潜在迟到帧落地（断言零的反面窗口）
      expect(rig.runner.sent).toHaveLength(0);
      const entries = rig.daemon.session.getSnapshot().session.entries;
      expect(entries.filter((e) => "role" in e && e.isSteer)).toHaveLength(0);
      expect(client.frames.some((f) => f.type === "steer.queued")).toBe(false);
    } finally {
      await client.close();
      await rig.daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
    }
  }, 15000);
});
