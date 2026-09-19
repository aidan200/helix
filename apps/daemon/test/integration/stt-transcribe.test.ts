/**
 * stt.transcribe 协议级集成（语音输入批 V1 Phase 1）：真 WsServerAdapter ×
 * loopback WS × DashScope 真体（fetch 注入 mock——协议链 + fetch 层注入形态
 * 双断言，code-review-handlers.test.ts rig 同构）。
 *
 * 覆盖：
 * - 合法链：hello → stt.transcribe（信封 sessionId 携带）→
 *   stt.transcribe.result ok 帧（channel=stt / text / provider）；
 * - P1 会话源：directory.getSessionView 消息文本 → system 前置消息
 *   （上下文增强通道）+ parameters.vocabulary（即时热词通道）fetch 层断言；
 *   音频经 OSS 三步上传后以 {audio: "oss://…"} 引用（fix/stt-oss-upload）；
 * - provider 选择：dashscope 无 key + siliconflow 有 key → 自动兜底；
 *   payload.provider 显式；全部未配 → error 判别回执（引导文案）；
 * - 防御面：payload.audio 非 data URL → commandError；adapter 抛错 →
 *   error 判别回执；未装配（deps.stt 缺省）→ command.unimplemented。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { WsServerAdapter } from "../../src/adapters/driving/ws-server/WsServerAdapter";
import { EventStream } from "../../src/adapters/driving/ws-server/EventStream";
import { StubBrowserPort } from "../mocks/StubBrowserPort";
import { DashScopeSttAdapter } from "../../src/adapters/driven/stt/dashscope";
import { SiliconFlowSttAdapter } from "../../src/adapters/driven/stt/siliconflow";
import type { SttPort, SttRequest } from "../../src/application/ports/outbound/SttPort";
import { PROTOCOL_VERSION, type FrameVersion } from "@helix/protocol";

interface Frame {
  v: FrameVersion;
  type: string;
  payload: Record<string, unknown>;
  sessionId?: string;
  channel?: string;
}

class TestClient {
  readonly frames: Frame[] = [];
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

  send(frame: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(frame));
  }

  /** 发命令并等待点对点回执（*.result）或 connection.error。 */
  async cmd(
    type: string,
    payload: Record<string, unknown>,
    timeoutMs = 5000,
    sessionId?: string,
  ): Promise<{ ok: boolean; result: Record<string, unknown>; error?: { code: string; message: string } }> {
    const before = this.frames.length;
    this.send({ v: PROTOCOL_VERSION, type, payload, ...(sessionId !== undefined ? { sessionId } : {}) });
    const resultType = `${type}.result`;
    await until(
      () =>
        this.frames.slice(before).some(
          (f) => f.type === resultType || (f.type === "connection.error" && String(f.payload.message ?? "").includes(type)),
        ),
      timeoutMs,
      `回执 ${resultType}`,
    );
    const frames = this.frames.slice(before);
    const errFrame = frames.find((f) => f.type === "connection.error");
    if (errFrame !== undefined) {
      return { ok: false, result: errFrame.payload, error: { code: String(errFrame.payload.code), message: String(errFrame.payload.message) } };
    }
    const res = frames.find((f) => f.type === resultType);
    if (res === undefined) throw new Error("回执帧缺失");
    return { ok: true, result: res.payload };
  }
}

async function until(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** fetch 层捕获 mock（DashScope 真体注入——协议链与注入形态双断言；三步路由：policy/上传/生成）。 */
function dashscopeFetchCapture(): { calls: { url: string; body: Record<string, unknown> }[]; fetchFn: typeof fetch } {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://dashscope.aliyuncs.com/api/v1/uploads")) {
      calls.push({ url: u, body: {} });
      return new Response(
        JSON.stringify({
          data: {
            policy: "POLICY",
            signature: "SIG",
            upload_dir: "dashscope-instant/it/2026-09-19",
            upload_host: "https://fake-oss.example.com",
            oss_access_key_id: "LTAI",
            x_oss_object_acl: "private",
            x_oss_forbid_overwrite: "true",
          },
        }),
        { status: 200 },
      );
    }
    if (u.startsWith("https://fake-oss.example.com")) {
      calls.push({ url: u, body: {} });
      return new Response("", { status: 200 });
    }
    calls.push({ url: u, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return new Response(JSON.stringify({ output: { text: "把 useEffect 修一下" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchFn };
}

/** adapter 依赖面 stub（code-review-handlers stubAdapterDeps 同构收窄）。 */
function stubAdapterDeps(events: EventStream, sessionEntries: { role: "user" | "assistant"; text: string }[]) {
  return {
    chat: {
      sendMessage: async () => ({ mode: "turn" as const, turnId: "t", entryId: "e" }),
      steer: async () => ({ entryId: "e" }),
      abort: () => {},
    },
    directory: {
      listSessions: async () => [],
      sessionExists: async () => true,
      resolveTarget: async () => "sess-stt",
      getSessionView: async () => ({
        session: {
          sessionId: "sess-stt",
          createdAt: "2026-09-19T00:00:00.000Z",
          entries: sessionEntries.map((e, i) => ({
            id: `e${i}`,
            role: e.role,
            text: e.text,
            turnId: null,
            isSteer: false,
            instanceId: "main",
            createdAt: "2026-09-19T00:00:00.000Z",
          })),
          turns: [],
          pendingSteer: [],
        },
        toolCalls: [],
      }),
      startDraftSession: async () => {
        throw new Error("stt 测试不装配草稿链");
      },
      deleteSession: async () => {},
      currentSessionId: () => "sess-stt",
    },
    system: {
      getStatus: () => ({
        running: true, locked: false, home: "/tmp/stt-it", sessionId: "sess-stt",
        agentState: "idle", model: "stub/model",
      }),
      shutdown: async () => {},
    },
    orchestration: {
      spawn: () => ({ status: "rejected" as const, error: "stt 测试不装配调度" }),
      send: () => ({ delivered: false, detail: "stub" }),
      status: () => [],
      kill: () => ({ killed: false, error: "stub" }),
      inspect: () => null,
      park: () => ({ parked: false as const, error: "测试桩不挂起" }),
      resume: () => ({ resumed: false as const, error: "测试桩不恢复" }),
    },
    model: {
      setModel: async () => { throw new Error("stub"); },
      setThinking: async () => { throw new Error("stub"); },
      getModel: async () => { throw new Error("stub"); },
      catalog: async () => { throw new Error("stub"); },
      catalogRefresh: async () => { throw new Error("stub"); },
      setThinkingDefault: async () => ({ previous: null }), setDefault: async () => { throw new Error("stub"); },
      getDefault: () => ({ model: "stub/model", thinkingDefault: null }),
      authList: async () => [],
      authSetKey: async () => { throw new Error("stub"); },
      authDeleteKey: async () => {},
      authVerify: async () => ({ status: "fail" as const, reason: "stub" }),
    },
    resource: {
      list: async () => { throw new Error("stub"); },
      getEffectiveSkills: async () => [],
      setEnabled: async () => { throw new Error("stub"); },
      setModelSlot: async () => { throw new Error("stub"); },
      clearModelSlot: async () => { throw new Error("stub"); },
      setThinkingSlot: async () => { throw new Error("stub"); },
      modelSlot: () => undefined, thinkingSlot: () => undefined, clearThinkingSlot: async () => { throw new Error("stub"); },
    },
    hasModel: () => false,
    kgWriterPinnedTools: ["kg-update"],
    basePrompts: {},
    browser: new StubBrowserPort(),
    events,
    token: "stt-it-token",
    port: 0,
  };
}

/** fake STT provider（FakeLLM 契约等价 mock 先例——记录请求 + 可编程结果）。 */
class FakeSttPort implements SttPort {
  constructor(
    readonly providerId: string,
    readonly calls: SttRequest[],
    private readonly outcome: () => Promise<{ text: string }> | never,
  ) {}
  async transcribe(request: SttRequest): Promise<{ text: string }> {
    this.calls.push(request);
    return this.outcome();
  }
}

const AUDIO = "data:audio/webm;codecs=opus;base64,SGVsbG8=";

describe("stt.transcribe 协议级集成（语音输入批 V1）", () => {
  const adapters: WsServerAdapter[] = [];
  afterAll(() => {
    for (const a of adapters) a.stop();
  });

  function launch(
    deps: ReturnType<typeof stubAdapterDeps>,
    stt?: { providers: readonly SttPort[]; apiKeyOf: (providerId: string) => string | undefined },
  ): TestClient {
    const adapter = new WsServerAdapter({ ...deps, ...(stt !== undefined ? { stt } : {}) });
    adapters.push(adapter);
    return new TestClient(`ws://127.0.0.1:${adapter.port}`);
  }

  async function handshake(client: TestClient): Promise<void> {
    await client.open();
    client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token: "stt-it-token", protocolVersion: PROTOCOL_VERSION } });
    await until(() => client.frames.some((f) => f.type === "connection.welcome"), 3000, "握手 welcome");
  }

  test("合法链 + P1 会话源注入：DashScope 真体 fetch mock——三步上传 + vocabulary 热词 + system 前置消息", async () => {
    const fetchCap = dashscopeFetchCapture();
    const events = new EventStream();
    const deps = stubAdapterDeps(events, [
      { role: "user", text: "帮我看下 useEffect 和 Tauri 的坑" },
      { role: "assistant", text: "useEffect 清理函数……" },
    ]);
    const client = launch(deps, {
      providers: [
        new DashScopeSttAdapter({ getApiKey: () => "sk-dash", fetchFn: fetchCap.fetchFn }),
        new SiliconFlowSttAdapter({ getApiKey: () => undefined }),
      ],
      apiKeyOf: (id) => (id === "dashscope" ? "sk-dash" : undefined),
    });
    await handshake(client);
    const res = await client.cmd("stt.transcribe", { audio: AUDIO, language: "zh" }, 5000, "sess-stt");
    expect(res.ok).toBe(true);
    expect(res.result.status).toBe("ok");
    expect(res.result.text).toBe("把 useEffect 修一下");
    expect(res.result.provider).toBe("dashscope");

    // fetch 层注入形态断言（三步链 + 双通道）
    expect(fetchCap.calls.length).toBe(3);
    expect(fetchCap.calls[0]!.url).toContain("action=getPolicy");
    expect(fetchCap.calls[1]!.url).toContain("fake-oss.example.com"); // multipart 上传
    const gen = fetchCap.calls[2]!.body as {
      input: { messages: { role: string; content: { text?: string; audio?: string }[] }[] };
      parameters: { vocabulary: Record<string, number> };
    };
    // system 前置上下文消息（fix/stt-oss-upload：上下文增强走 system 消息）
    const hintText = gen.input.messages[0]!.content[0]!.text ?? "";
    expect(gen.input.messages[0]!.role).toBe("system");
    expect(hintText).toContain("useEffect"); // P1 会话源 token 入选
    expect(hintText).toContain("Tauri");
    // 音频引用形态：{audio: "oss://…"}（data URL 直传已证伪）
    const lastMsg = gen.input.messages[gen.input.messages.length - 1]!;
    expect((lastMsg.content[0]!.audio ?? "").startsWith("oss://dashscope-instant/")).toBe(true);
    expect(gen.parameters.vocabulary["useEffect"]).toBeGreaterThanOrEqual(1); // 即时热词通道
    expect(gen.parameters.vocabulary["git"]).toBe(1); // P3 基础词表入选（weight ×1）
  });

  test("provider 自动兜底：dashscope 无 key + siliconflow 有 key → siliconflow 执行", async () => {
    const events = new EventStream();
    const deps = stubAdapterDeps(events, []);
    const sfCalls: SttRequest[] = [];
    const client = launch(deps, {
      providers: [
        new DashScopeSttAdapter({ getApiKey: () => undefined }), // 无 key
        new FakeSttPort("siliconflow", sfCalls, async () => ({ text: "兜底文本" })),
      ],
      apiKeyOf: (id) => (id === "siliconflow" ? "sk-sf" : undefined),
    });
    await handshake(client);
    const res = await client.cmd("stt.transcribe", { audio: AUDIO }, 5000, "sess-stt");
    expect(res.ok).toBe(true);
    expect(res.result.status).toBe("ok");
    expect(res.result.provider).toBe("siliconflow");
    expect(sfCalls.length).toBe(1);
    expect(sfCalls[0]!.context.hint).toContain("git"); // 基础词表（P3）注入 hint
  });

  test("全部 provider 未配 key → error 判别回执（引导文案）", async () => {
    const events = new EventStream();
    const deps = stubAdapterDeps(events, []);
    const client = launch(deps, {
      providers: [new FakeSttPort("dashscope", [], async () => ({ text: "不应执行" }))],
      apiKeyOf: () => undefined,
    });
    await handshake(client);
    const res = await client.cmd("stt.transcribe", { audio: AUDIO });
    expect(res.ok).toBe(true); // error 是业务判别（结果帧），非 connection.error
    expect(res.result.status).toBe("error");
    expect(String(res.result.reason)).toContain("auth.set_key");
  });

  test("payload.audio 非 data URL → commandError（command.invalid_payload）", async () => {
    const events = new EventStream();
    const deps = stubAdapterDeps(events, []);
    const client = launch(deps, {
      providers: [new FakeSttPort("dashscope", [], async () => ({ text: "不应执行" }))],
      apiKeyOf: () => "k",
    });
    await handshake(client);
    const res = await client.cmd("stt.transcribe", { audio: "https://example.com/a.wav" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("command.invalid_payload");
  });

  test("adapter 抛错（provider 拒绝）→ error 判别回执透传原因", async () => {
    const events = new EventStream();
    const deps = stubAdapterDeps(events, []);
    const failing: SttPort = {
      providerId: "dashscope",
      transcribe: async () => {
        throw new Error("DashScope 转写失败（HTTP 429）");
      },
    };
    const client = launch(deps, { providers: [failing], apiKeyOf: () => "k" });
    await handshake(client);
    const res = await client.cmd("stt.transcribe", { audio: AUDIO });
    expect(res.ok).toBe(true);
    expect(res.result.status).toBe("error");
    expect(String(res.result.reason)).toContain("429");
  });

  test("未装配（deps.stt 缺省）→ command.unimplemented", async () => {
    const events = new EventStream();
    const client = launch(stubAdapterDeps(events, [])); // 无 stt 面
    await handshake(client);
    const res = await client.cmd("stt.transcribe", { audio: AUDIO });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("command.unimplemented");
  });
});
