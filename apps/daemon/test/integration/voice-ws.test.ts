/**
 * 语音播报批（V2 TTS）WS 全链集成：
 * - fake TTS provider 注入（voiceTtsOverride 接缝）→ 真实 WS 连接
 *   voice.subscribe → orchestration.spawn（FakeAgentEngine + KillableRunner
 *   挂起形态，测试 forceClosure 驱动收口）→ agent.completed 经 fanout
 *   voice-broadcast-bridge → BroadcastService 粗筛/极简通知/合成 →
 *   voice.broadcast 广播帧到达已订阅连接（payload 含 fake 音频 data URL
 *   + kind/agentId/text/seq）；
 * - 闸门负例：无订阅连接时收口 → 零合成（money gate——开关默认 off 落地面）；
 *   未订阅连接收不到 voice.broadcast（连接级过滤投递）；
 * - voice.synthesize 无 key 形态：error 判别回执（含设置页录入引导）——
 *   真实 DashScopeTtsAdapter fail-fast 链（临时 home 无 auth.json key）；
 * - payload 非法（text 空串）：commandError 通道（协议面错误语义）。
 *
 * Rig 形态 = agent-ws.test.ts 同构（spawn 驱动面复用 KillableRunner 挂起收口）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { PROTOCOL_VERSION } from "@helix/protocol";
import type { VoiceBroadcastPayload } from "@helix/protocol";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { KillableRunner } from "./helpers/KillableRunner";
import type { TtsPort, TtsRequest, TtsResult } from "../../src/application/ports/outbound/TtsPort";

const FAKE_AUDIO = "data:audio/wav;base64,RklGRg==";

interface Frame {
  v: number;
  type: string;
  payload: Record<string, unknown>;
  sessionId?: string;
  channel?: string;
  instanceId?: string;
}

class TestClient {
  readonly frames: Frame[] = [];
  private readonly ws: WebSocket;

  constructor(url: string, token: string) {
    this.ws = new WebSocket(url);
    this.ws.onopen = () => this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "hello", payload: { token, protocolVersion: PROTOCOL_VERSION } }));
    this.ws.onmessage = (ev: MessageEvent) => {
      this.frames.push(JSON.parse(String(ev.data)));
    };
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  async expect(type: string, timeoutMs = 3000): Promise<Frame> {
    const t0 = Date.now();
    while (!this.frames.some((f) => f.type === type)) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${type}（已收 ${this.frames.map((f) => f.type).slice(-8).join(",")}）`);
      await new Promise((r) => setTimeout(r, 5));
    }
    return this.frames.find((f) => f.type === type)!;
  }

  async open(timeoutMs = 3000): Promise<void> {
    const t0 = Date.now();
    while (this.ws.readyState !== WebSocket.OPEN) {
      if (Date.now() - t0 > timeoutMs) throw new Error("WS 连接建立超时");
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}

/** fake TTS：记录请求、返回固定 data URL。 */
function fakeTts(): TtsPort & { calls: TtsRequest[] } {
  const calls: TtsRequest[] = [];
  return {
    providerId: "dashscope",
    calls,
    async synthesize(req: TtsRequest): Promise<TtsResult> {
      calls.push(req);
      return { audio: FAKE_AUDIO };
    },
  };
}

interface Rig {
  home: string;
  daemon: Awaited<ReturnType<typeof createTestDaemon>>;
  tts: TtsPort & { calls: TtsRequest[] };
  runner: KillableRunner;
  client: TestClient;
  client2: TestClient;
  dispose: () => Promise<void>;
}

async function makeRig(): Promise<Rig> {
  const home = mkdtempSync(path.join(tmpdir(), "helix-voice-tts-"));
  const engine = new FakeAgentEngine();
  const runner = new KillableRunner();
  const tts = fakeTts();
  const daemon = await createTestDaemon({
    home,
    engine,
    skipConfig: true,
    port: 0,
    skipLock: true,
    subagentRunner: runner,
    voiceTts: tts,
    cliInput: new PassThrough(),
    cliOutput: new PassThrough(),
    kgWorkspaceRoot: home,
  });
  const token = readFileSync(path.join(home, "dev-token"), "utf8").trim();
  const client = new TestClient(daemon.ws.url, token);
  await client.open();
  await client.expect("connection.welcome", 3000);
  if (client.frames[0]!.payload.draft === true) {
    client.send({ v: PROTOCOL_VERSION, type: "session.subscribe", payload: {} });
  }
  await client.expect("session.snapshot", 3000);
  // 第二连接（闸门/投递负例观察者：不订阅 voice）
  const client2 = new TestClient(daemon.ws.url, token);
  await client2.open();
  await client2.expect("connection.welcome", 3000);
  return {
    home,
    daemon,
    tts,
    runner,
    client,
    client2,
    dispose: async () => {
      await client.close();
      await client2.close();
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

/** spawn → 等 spawned 帧拿 agentId → forceClosure done → 返回 agentId。 */
async function spawnAndComplete(rig: Rig, summary: string): Promise<string> {
  const spawn = rig.daemon.orchestration.spawn(summary);
  expect(spawn.status === "run" || spawn.status === "queued").toBe(true);
  const spawned = await rig.client.expect("agent.spawned", 5000);
  const agentId = String(spawned.instanceId);
  rig.runner.forceClosure(agentId, {
    result: "done",
    closure: { status: "done", summary, reportPath: null, findings: null, taskId: null },
  });
  return agentId;
}

describe("voice 族：播报全链（fanout voice-broadcast-bridge → 广播帧）", () => {
  test("voice.subscribe → agent.completed → voice.broadcast 帧到达已订阅连接（fake 音频）", async () => {
    const rig = (current = await makeRig());
    // 订阅播报（音色偏好随命令携带）
    rig.client.send({ v: PROTOCOL_VERSION, type: "voice.subscribe", payload: { voice: "Cherry" } });
    await new Promise((r) => setTimeout(r, 50)); // 订阅登记落位

    const agentId = await spawnAndComplete(rig, "V2 播报全链验证");
    const broadcast = await rig.client.expect("voice.broadcast", 5000);

    // 广播帧形态：系统级信封 + voice 通道 + fake 音频
    expect(broadcast.channel).toBe("voice");
    expect(broadcast.sessionId).toBe("__system__");
    const payload = broadcast.payload as unknown as VoiceBroadcastPayload;
    expect(payload.kind).toBe("agent.completed");
    expect(payload.agentId).toBe(agentId);
    expect(payload.text).toBe("后台任务已完成");
    expect(payload.audio).toBe(FAKE_AUDIO);
    expect(payload.provider).toBe("dashscope");
    expect(payload.seq).toBeGreaterThanOrEqual(1);

    // 合成请求形态：极简通知文本 + 订阅携带音色
    expect(rig.tts.calls.length).toBe(1);
    expect(rig.tts.calls[0]!.voice).toBe("Cherry");
    expect(rig.tts.calls[0]!.text).toBe("后台任务已完成");

    // 投递负例：未订阅连接（client2）收不到 voice.broadcast
    expect(rig.client2.frames.some((f) => f.type === "voice.broadcast")).toBe(false);
  });

  test("闸门负例：无订阅连接时收口 → 零合成（money gate——默认 off 落地面）", async () => {
    const rig = (current = await makeRig());
    // 不订阅 voice，直接 spawn 收口
    const agentId = await spawnAndComplete(rig, "闸门负例任务");
    await rig.client.expect("agent.completed", 5000);
    await new Promise((r) => setTimeout(r, 100));
    expect(rig.tts.calls.length).toBe(0); // 零合成零花费
    expect(agentId).not.toBe("");
  });

  test("voice.unsubscribe 后收口不再合成", async () => {
    const rig = (current = await makeRig());
    rig.client.send({ v: PROTOCOL_VERSION, type: "voice.subscribe", payload: {} });
    await new Promise((r) => setTimeout(r, 50));
    await spawnAndComplete(rig, "退订前任务");
    await rig.client.expect("voice.broadcast", 5000);
    expect(rig.tts.calls.length).toBe(1);

    rig.client.send({ v: PROTOCOL_VERSION, type: "voice.unsubscribe", payload: {} });
    await new Promise((r) => setTimeout(r, 50));
    await spawnAndComplete(rig, "退订后任务");
    await rig.client.expect("agent.completed", 5000);
    await new Promise((r) => setTimeout(r, 150));
    expect(rig.tts.calls.length).toBe(1); // 退订后零合成
  });

  test("spawned/started 事件不播（粗筛负例）：合成文本恒为极简终态通知", async () => {
    const rig = (current = await makeRig());
    rig.client.send({ v: PROTOCOL_VERSION, type: "voice.subscribe", payload: {} });
    await new Promise((r) => setTimeout(r, 50));
    await spawnAndComplete(rig, "粗筛负例任务");
    await rig.client.expect("voice.broadcast", 5000);
    for (const call of rig.tts.calls) {
      expect(call.text).toContain("已完成");
      expect(call.text).not.toContain("已入队");
      expect(call.text).not.toContain("已开始");
    }
  });
});

describe("voice.synthesize：试听合成命令", () => {
  test("无 key 形态 → error 判别回执（设置页录入引导；真实 adapter fail-fast）", async () => {
    // 无 voiceTts 注入 → 真实 DashScopeTtsAdapter；临时 home auth.json 无 key
    const home = mkdtempSync(path.join(tmpdir(), "helix-voice-synth-"));
    const engine = new FakeAgentEngine();
    const daemon = await createTestDaemon({
      home,
      engine,
      skipConfig: true,
      port: 0,
      skipLock: true,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
      kgWorkspaceRoot: home,
    });
    try {
      const token = readFileSync(path.join(home, "dev-token"), "utf8").trim();
      const client = new TestClient(daemon.ws.url, token);
      await client.open();
      await client.expect("connection.welcome", 3000);
      client.send({ v: PROTOCOL_VERSION, type: "voice.synthesize", payload: { text: "播报测试" } });
      const result = await client.expect("voice.synthesize.result", 5000);
      expect(result.channel).toBe("voice");
      expect(result.payload.status).toBe("error");
      expect(String(result.payload.reason)).toContain("API key");
      expect(String(result.payload.reason)).toContain("auth.set_key");
      await client.close();
    } finally {
      await daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("fake TTS 注入形态 → ok 判别回执（audio data URL + provider 回显）", async () => {
    const rig = (current = await makeRig());
    rig.client.send({ v: PROTOCOL_VERSION, type: "voice.synthesize", payload: { text: "试听测试", voice: "Cherry" } });
    const result = await rig.client.expect("voice.synthesize.result", 5000);
    expect(result.payload.status).toBe("ok");
    expect(result.payload.audio).toBe(FAKE_AUDIO);
    expect(result.payload.provider).toBe("dashscope");
    expect(result.payload.voice).toBe("Cherry");
    expect(rig.tts.calls[0]!.text).toBe("试听测试");
  });

  test("text 空串 → commandError 通道（协议面错误语义）", async () => {
    const rig = (current = await makeRig());
    rig.client.send({ v: PROTOCOL_VERSION, type: "voice.synthesize", payload: { text: "" } });
    const err = await rig.client.expect("connection.error", 3000);
    expect(String(err.payload.message)).toContain("payload.text");
  });
});
