/**
 * 流式 TTS 批（V3b-2）voice.synthesize.stream / voice.synthesize.stop WS 全链
 * 集成——哑帧修复批验收用例：
 * - 命令分发可达：已握手连接发送 voice.synthesize.stream 必收帧序列——
 *   绝不允许零响应（探针实测「无 chunk、无 done、无 error、无 commandError」
 *   即本批修复标的）；
 * - 失败路径必发 error 帧：①无 key 形态（TtsStreamService select →
 *   configured=false → voice.synthesize.error，含设置页录入引导）；②上游
 *   失败（fake port onError → voice.synthesize.error）；
 * - 成功路径：fake streaming port（onAudio×2 → onDone）→ chunk×2 + done
 *   （seq 句内 1 起单调；provider 回显）；
 * - payload 非法（utterId/text 缺失）→ commandError 通道（协议面错误语义，
 *   voice.synthesize 先例）。
 *
 * Rig 形态 = voice-ws.test.ts 同构（createTestDaemon + TestClient）；流式面
 * 经 voiceTtsStream 接缝注入 fake TtsStreamPort（零真实网络）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { PROTOCOL_VERSION } from "@helix/protocol";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { TtsStreamService } from "../../src/application/tts/TtsStreamService";
import type { TtsStreamUtterOptions } from "../../src/application/tts/TtsStreamService";
import type { TtsPort, TtsRequest, TtsResult } from "../../src/application/ports/outbound/TtsPort";

const FAKE_PCM = "AAAA"; // base64 PCM（内容不敏感——透传断言）

interface Frame {
  v: number;
  type: string;
  payload: Record<string, unknown>;
  sessionId?: string;
  channel?: string;
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

/** fake 一次性 TTS（voice.synthesize 回退链目标；本文件仅装配面需要非空）。 */
function fakeTts(): TtsPort {
  return {
    providerId: "dashscope",
    async synthesize(_req: TtsRequest): Promise<TtsResult> {
      return { audio: `data:audio/wav;base64,${FAKE_PCM}` };
    },
  };
}

/** fake 流式 TtsStreamService：剧本驱动（utter 时同步发帧序列或抛异常）。 */
class FakeTtsStreamService extends TtsStreamService {
  readonly utters: TtsStreamUtterOptions[] = [];
  constructor(
    private readonly script: (opts: TtsStreamUtterOptions) => void,
  ) {
    super({ adapters: [], apiKeyOf: () => undefined });
  }
  override utter(_sender: object, opts: TtsStreamUtterOptions): void {
    this.utters.push(opts);
    this.script(opts);
  }
}

function chunkFrame(opts: TtsStreamUtterOptions, seq: number): Parameters<TtsStreamUtterOptions["emit"]>[0] {
  return {
    v: PROTOCOL_VERSION,
    sessionId: opts.sessionId,
    channel: "voice",
    type: "voice.synthesize.chunk",
    payload: { utterId: opts.utterId, seq, audio: FAKE_PCM },
  } as Parameters<TtsStreamUtterOptions["emit"]>[0];
}

function doneFrame(opts: TtsStreamUtterOptions, frames: number): Parameters<TtsStreamUtterOptions["emit"]>[0] {
  return {
    v: PROTOCOL_VERSION,
    sessionId: opts.sessionId,
    channel: "voice",
    type: "voice.synthesize.done",
    payload: { utterId: opts.utterId, provider: "dashscope", frames },
  } as Parameters<TtsStreamUtterOptions["emit"]>[0];
}

function errorFrame(opts: TtsStreamUtterOptions, reason: string): Parameters<TtsStreamUtterOptions["emit"]>[0] {
  return {
    v: PROTOCOL_VERSION,
    sessionId: opts.sessionId,
    channel: "voice",
    type: "voice.synthesize.error",
    payload: { utterId: opts.utterId, reason },
  } as Parameters<TtsStreamUtterOptions["emit"]>[0];
}

interface Rig {
  home: string;
  daemon: Awaited<ReturnType<typeof createTestDaemon>>;
  client: TestClient;
  dispose: () => Promise<void>;
}

interface RigOptions {
  voiceTtsStream?: TtsStreamService;
}

async function makeRig(options: RigOptions = {}): Promise<Rig> {
  const home = mkdtempSync(path.join(tmpdir(), "helix-voice-tts-stream-"));
  const engine = new FakeAgentEngine();
  const daemon = await createTestDaemon({
    home,
    engine,
    skipConfig: true,
    port: 0,
    skipLock: true,
    voiceTts: fakeTts(),
    ...(options.voiceTtsStream !== undefined ? { voiceTtsStream: options.voiceTtsStream } : {}),
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
  return {
    home,
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

describe("voice.synthesize.stream：命令分发可达（哑帧修复验收）", () => {
  test("无 key 形态 → 必收 voice.synthesize.error 帧（零响应 = 回归红线）", async () => {
    // 不注入 voiceTtsStream → 真实 DashScopeStreamingTtsAdapter；临时 home 无
    // auth.json key → TtsStreamService emitError（含设置页录入引导）
    const rig = (current = await makeRig());
    rig.client.send({ v: PROTOCOL_VERSION, type: "voice.synthesize.stream", payload: { utterId: "u1", text: "第一句测试。" } });
    const err = await rig.client.expect("voice.synthesize.error", 3000);
    expect(err.channel).toBe("voice");
    expect(String(err.payload.utterId)).toBe("u1");
    expect(String(err.payload.reason)).toContain("API key");
  });

  test("fake service 剧本成功 → chunk×2 + done（seq 单调；provider 回显）", async () => {
    const port = new FakeTtsStreamService((opts) => {
      opts.emit(chunkFrame(opts, 1));
      opts.emit(chunkFrame(opts, 2));
      opts.emit(doneFrame(opts, 2));
    });
    const rig = (current = await makeRig({ voiceTtsStream: port }));
    rig.client.send({ v: PROTOCOL_VERSION, type: "voice.synthesize.stream", payload: { utterId: "u2", text: "第二句测试。", voice: "longanlingxi" } });
    const chunk1 = await rig.client.expect("voice.synthesize.chunk", 3000);
    expect(chunk1.channel).toBe("voice");
    expect(chunk1.payload.utterId).toBe("u2");
    expect(chunk1.payload.seq).toBe(1);
    expect(chunk1.payload.audio).toBe(FAKE_PCM);
    await rig.client.expect("voice.synthesize.done", 3000);
    const chunks = rig.client.frames.filter((f) => f.type === "voice.synthesize.chunk");
    const done = rig.client.frames.find((f) => f.type === "voice.synthesize.done")!;
    expect(chunks.map((c) => c.payload.seq)).toEqual([1, 2]);
    expect(done.payload.utterId).toBe("u2");
    expect(done.payload.provider).toBe("dashscope");
    expect(done.payload.frames).toBe(2);
    // 开句参数形态：整句文本 + 音色透传
    expect(port.utters[0]!.text).toBe("第二句测试。");
    expect(port.utters[0]!.voice).toBe("longanlingxi");
  });

  test("fake service 上游失败 → 必发 error 帧（失败路径不哑帧）", async () => {
    const rig = (current = await makeRig({
      voiceTtsStream: new FakeTtsStreamService((opts) => {
        opts.emit(errorFrame(opts, "上游合成失败（mock）"));
      }),
    }));
    rig.client.send({ v: PROTOCOL_VERSION, type: "voice.synthesize.stream", payload: { utterId: "u3", text: "失败句。" } });
    const err = await rig.client.expect("voice.synthesize.error", 3000);
    expect(String(err.payload.reason)).toContain("上游合成失败");
  });

  test("服务层同步抛异常 → daemon.internal 兑底回执（零响应红线）且连接保持", async () => {
    // 哑帧机制钉死：handler/服务链同步抛 → 无兑底网时 Bun message 回调内
    // 异常被吞 = 零帧零断连；修复后必回 connection.error(daemon.internal)
    const rig = (current = await makeRig({
      voiceTtsStream: new FakeTtsStreamService(() => {
        throw new Error("TtsStreamService 入口毒化异常");
      }),
    }));
    rig.client.send({ v: PROTOCOL_VERSION, type: "voice.synthesize.stream", payload: { utterId: "u4", text: "毒化句。" } });
    const err = await rig.client.expect("connection.error", 3000);
    expect(String(err.payload.code)).toBe("daemon.internal");
    expect(String(err.payload.message)).toContain("毒化异常");
    expect(String(err.payload.message)).toContain("（命令 voice.synthesize.stream）"); // TR-145 尾缀归因契约
    // 连接保持：后续合法命令照常响应
    rig.client.send({ v: PROTOCOL_VERSION, type: "voice.synthesize", payload: { text: "存活探测" } });
    const alive = await rig.client.expect("voice.synthesize.result", 5000);
    expect(alive.payload.status).toBe("ok");
  });

  test("payload.utterId 缺失 → commandError 通道（协议面错误语义）", async () => {
    const rig = (current = await makeRig());
    rig.client.send({ v: PROTOCOL_VERSION, type: "voice.synthesize.stream", payload: { text: "缺 utterId。" } });
    const err = await rig.client.expect("connection.error", 3000);
    expect(String(err.payload.message)).toContain("payload.utterId");
  });
});
