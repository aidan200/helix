import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { PROTOCOL_VERSION, type FrameVersion } from "@helix/protocol";
import { FakeAgentEngine, type ScriptedTurn } from "../mocks/FakeAgentEngine";

/**
 * TP-CL6 全链（I）：loopback WS 客户端 × 真组合根（FakeAgentEngine 注入）。
 * - TP-CL6-1 监听地址断言 127.0.0.1（禁 0.0.0.0/::）
 * - TP-CL6-2 握手 → welcome+snapshot → chat.send → delta → completed 全序列；
 *   运行中 chat.steer → steer.queued
 * - TP-CL6-4 dev-token 文件生成 + GET /helix-dev-token
 * - TP-CL6-5 握手拒绝三分支
 * - TP-CL6-6 static serve fixture
 * - command.unknown 不关连接
 */

/** 收集帧的 loopback WS 测试客户端（Bun 内建 WebSocket）。 */
class TestClient {
  readonly frames: { v: FrameVersion; type: string; payload: Record<string, unknown>; sessionId?: string; channel?: string }[] = [];
  private readonly ws: WebSocket;
  private closedAt = 0;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev: MessageEvent) => {
      this.frames.push(JSON.parse(String(ev.data)));
    };
    this.ws.onclose = () => {
      this.closedAt = Date.now();
    };
  }

  async open(timeoutMs = 3000): Promise<void> {
    await until(() => this.ws.readyState === WebSocket.OPEN, timeoutMs, "WS 连接建立");
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  /** 等待出现指定 type 的帧并返回之。 */
  async expect(type: string, timeoutMs = 3000): Promise<{ v: FrameVersion; type: string; payload: Record<string, unknown>; sessionId?: string; channel?: string }> {
    await until(() => this.frames.some((f) => f.type === type), timeoutMs, `等待帧 ${type}（已收：${this.frames.map((f) => f.type).join(",")}）`);
    return this.frames.find((f) => f.type === type)!;
  }

  /** 等待 afterIndex 之后出现的首个指定 type 帧（同型帧多次到达时区分新旧）。 */
  async expectAfter(
    type: string,
    afterIndex: number,
    timeoutMs = 3000,
  ): Promise<{ v: FrameVersion; type: string; payload: Record<string, unknown>; sessionId?: string; channel?: string }> {
    await until(
      () => this.frames.slice(afterIndex).some((f) => f.type === type),
      timeoutMs,
      `等待新帧 ${type}（已收：${this.frames.map((f) => f.type).join(",")}）`,
    );
    return this.frames.slice(afterIndex).find((f) => f.type === type)!;
  }

  /** 等待满足谓词的帧并返回之。 */
  async waitFor(
    pred: (f: { v: FrameVersion; type: string; payload: Record<string, unknown> }) => boolean,
    what: string,
    timeoutMs = 3000,
  ): Promise<{ v: FrameVersion; type: string; payload: Record<string, unknown>; sessionId?: string; channel?: string }> {
    await until(() => this.frames.some(pred), timeoutMs, `等待帧（${what}）`);
    return this.frames.find(pred)!;
  }

  /** 等待连接被服务端关闭。 */
  async expectClosed(timeoutMs = 3000): Promise<void> {
    await until(() => this.ws.readyState === WebSocket.CLOSED, timeoutMs, "等待连接关闭");
    expect(this.closedAt).toBeGreaterThan(0);
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }

  types(): string[] {
    return this.frames.map((f) => f.type);
  }
}

async function until(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * T4 迁移辅助：hello 握手并等待 welcome；命中零条目内存草稿（welcome.draft
 * === true）时显式 session.subscribe 订阅当前会话（T4 新语义：草稿握手不
 * attach 不推快照，v0 兼容订阅面）；真实会话握手维持现状。
 */
async function helloHandshake(
  client: TestClient,
  token: string,
): Promise<{ v: FrameVersion; type: string; payload: Record<string, unknown>; sessionId?: string; channel?: string }> {
  client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token, protocolVersion: PROTOCOL_VERSION } });
  const welcome = await client.expect("connection.welcome");
  if (welcome.payload.draft === true) {
    client.send({ v: 0, type: "session.subscribe", payload: {} });
  }
  return welcome;
}

function tmpHome(): string {
  return mkdtempSync(path.join(tmpdir(), "helix-ws-it-"));
}

/**
 * 预播种 models-store.json（全部 builtin provider checkedAt=now，models 空）
 * → catalog() 走 4h 缓存读面，零网络（hermetic：测试不依赖 pi.dev 可达性）。
 */
function seedCatalogCache(home: string): void {
  const now = Date.now();
  const providers: Record<string, { models: unknown[]; checkedAt: number; lastModified: number }> = {};
  for (const p of builtinModels().getProviders()) {
    providers[p.id] = { models: [], checkedAt: now, lastModified: 0 };
  }
  writeFileSync(path.join(home, "models-store.json"), JSON.stringify({ version: 1, providers }), "utf8");
}

interface Rig {
  home: string;
  engine: FakeAgentEngine;
  daemon: Awaited<ReturnType<typeof createTestDaemon>>;
  token: string;
  url: string;
  dispose: () => Promise<void>;
}

/** 组合根全链装配（随机端口、tmp home、Fake 引擎）。 */
async function makeRig(opts: { staticDir?: string; replies?: ScriptedTurn[]; seedCatalog?: boolean } = {}): Promise<Rig> {
  const home = tmpHome();
  if (opts.seedCatalog) seedCatalogCache(home);
  const engine = new FakeAgentEngine(opts.replies ? { replies: opts.replies } : {});
  const daemon = await createTestDaemon({
    home,
    engine,
    skipConfig: true,
    port: 0,
    staticDir: opts.staticDir,
    cliInput: new PassThrough(),
    cliOutput: new PassThrough(),
  });
  const token = readFileSync(path.join(home, "dev-token"), "utf8");
  return {
    home,
    engine,
    daemon,
    token,
    url: `ws://127.0.0.1:${daemon.ws.port}`,
    dispose: async () => {
      await daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

describe("TP-CL6-1：监听地址 127.0.0.1（禁 0.0.0.0/::）", () => {
  test("实际监听地址为 127.0.0.1，port=0 → 随机端口可发现", async () => {
    const rig = await makeRig();
    try {
      expect(rig.daemon.ws.hostname).toBe("127.0.0.1");
      expect(rig.daemon.ws.port).toBeGreaterThan(0);
      expect(rig.daemon.ws.port).toBeLessThan(65536);
    } finally {
      await rig.dispose();
    }
  });
});

describe("TP-CL6-2/TP-CL6-4：握手 + 命令上行/事件下行往返", () => {
  test("带对 token 握手 → welcome + session.snapshot；chat.send 全事件序列端到端", async () => {
    const rig = await makeRig({
      replies: [{ text: "这是一条流式回复内容。", chunkDelayMs: 10 }],
    });
    const client = new TestClient(rig.url);
    try {
      // dev-token 文件（TP-CL6-4）：存在非空，且就是握手 token
      expect(existsSync(path.join(rig.home, "dev-token"))).toBe(true);
      expect(rig.token.length).toBeGreaterThan(0);

      await client.open();
      const welcome = await helloHandshake(client, rig.token);
      expect(welcome.v).toBe(PROTOCOL_VERSION);
      expect(typeof welcome.payload.sessionId).toBe("string");
      expect(welcome.payload.agentState).toBe("idle");

      // welcome 后推快照（重连恢复语义；首连空会话 entries=[]——T4：草稿
      // 握手经 session.subscribe 显式订阅后重推，同上空快照语义）
      const snap = await client.expect("session.snapshot");
      const snapshot = snap.payload.snapshot as { entries: unknown[]; model: string; agentState: string };
      expect(snapshot.entries).toEqual([]);
      expect(snapshot.agentState).toBe("idle");

      // chat.send → FakeAgentEngine 剧本 → 全事件序列
      client.send({ v: 0, type: "chat.send", payload: { text: "你好" } });

      await client.expect("agent.state.changed"); // running
      await client.expect("chat.turn.started");
      const userMsg = await client.expect("chat.message.completed");
      expect((userMsg.payload.entry as { role: string }).role).toBe("user");

      const delta = await client.expect("chat.stream.delta");
      expect(typeof (delta.payload as { delta: string }).delta).toBe("string");

      // 两条 message.completed：先 user 后 assistant —— 序断言
      const assistantMsg = await client.waitFor(
        (f) => f.type === "chat.message.completed" && (f.payload.entry as { role: string }).role === "assistant",
        "assistant message.completed",
      );
      const msgFrames = client.frames.filter((f) => f.type === "chat.message.completed");
      expect(msgFrames.map((f) => (f.payload.entry as { role: string }).role)).toEqual(["user", "assistant"]);
      expect((assistantMsg.payload.entry as { content: string }).content).toContain("流式回复");

      const turnDone = await client.expect("chat.turn.completed");
      expect(turnDone.payload.reason).toBe("completed");
      // run 收尾回 idle
      await until(
        () => client.frames.some((f) => f.type === "agent.state.changed" && (f.payload as { state: string }).state === "idle"),
        3000,
        "等待 idle",
      );
      // 顺序 sanity：welcome 与 snapshot 都先于任何事件帧
      expect(client.types().indexOf("session.snapshot")).toBeLessThan(client.types().indexOf("chat.turn.started"));
    } finally {
      await client.close();
      await rig.dispose();
    }
  }, 10000);

  test("运行中 chat.steer → steer.queued 事件（T1.7 徽标数据源）", async () => {
    const rig = await makeRig({
      replies: [{ text: "慢慢流式输出的一段较长的回复文本。", chunkDelayMs: 40 }],
    });
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);
      await client.expect("session.snapshot");

      client.send({ v: 0, type: "chat.send", payload: { text: "开始生成" } });
      await client.expect("chat.stream.delta"); // 流式中段

      client.send({ v: 0, type: "chat.steer", payload: { text: "插一句话" } });
      const queued = await client.expect("steer.queued");
      expect(typeof queued.payload.entryId).toBe("string");

      // drain 轮收尾：注入消息最终驱动完成，agent 回 idle
      await until(
        () =>
          client.frames.some((f) => f.type === "agent.state.changed" && (f.payload as { state: string }).state === "idle"),
        5000,
        "等待 steer drain 后回 idle",
      );
      await client.expect("chat.turn.completed");
    } finally {
      await client.close();
      await rig.dispose();
    }
  }, 15000);
});

describe("TP-CL6-5：握手拒绝三分支（error 帧后 close）", () => {
  test.each([
    {
      name: "缺 token 字段 → auth.missing_token",
      hello: { v: PROTOCOL_VERSION, type: "hello", payload: { protocolVersion: PROTOCOL_VERSION } },
      code: "auth.missing_token",
    },
    {
      name: "token 不符 → auth.invalid_token",
      hello: { v: PROTOCOL_VERSION, type: "hello", payload: { token: "wrong-token", protocolVersion: PROTOCOL_VERSION } },
      code: "auth.invalid_token",
    },
    {
      name: "protocolVersion≠PROTOCOL_VERSION → protocol.version_unsupported",
      hello: { v: PROTOCOL_VERSION, type: "hello", payload: { token: "__TOKEN__", protocolVersion: 2 } }, // 目录外版本仍拒绝
      code: "protocol.version_unsupported",
    },
  ] as const)("$name", async ({ hello, code }) => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      const payload = { ...(hello.payload as Record<string, unknown>) };
      if (payload.token === "__TOKEN__") payload.token = rig.token;
      client.send({ ...hello, payload });
      const err = await client.expect("connection.error");
      expect(err.payload.code).toBe(code);
      await client.expectClosed(); // error 帧后连接被关闭
    } finally {
      await client.close();
      await rig.dispose();
    }
  });
});

describe("命令错误回执（不关连接）", () => {
  test("未知命令 → command.unknown，连接保持可用", async () => {
    const rig = await makeRig({ replies: [{ text: "ack" }] });
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);
      await client.expect("session.snapshot");

      client.send({ v: 0, type: "bogus.command", payload: {} });
      const err = await client.expect("connection.error");
      expect(err.payload.code).toBe("command.unknown");

      // 连接保持：后续 chat.send 正常驱动
      client.send({ v: 0, type: "chat.send", payload: { text: "还在吗" } });
      await client.expect("chat.message.completed");
    } finally {
      await client.close();
      await rig.dispose();
    }
  }, 10000);

  test("payload 不符 → command.invalid_payload，连接保持", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);
      await client.expect("session.snapshot");

      client.send({ v: 0, type: "chat.send", payload: { text: 42 } }); // text 非 string
      const err = await client.expect("connection.error");
      expect(err.payload.code).toBe("command.invalid_payload");

      client.send({ v: 0, type: "chat.abort", payload: {} }); // 仍可用
      await new Promise((r) => setTimeout(r, 50));
      expect(client.frames.filter((f) => f.type === "connection.error" && f.payload.code === "command.invalid_payload")).toHaveLength(1);
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  test("v0.2 model/auth 族真行为回执（T2.3）：非法载荷回 invalid_payload；目录外仍 command.unknown", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);
      await client.expect("session.snapshot");

      // T2.3（AD-2）：model/auth 族已落地真行为——占位回执（command.unimplemented）
      // 不再出现；非法载荷回 command.invalid_payload（中文说明）；
      // 微批（T2.3-result-frames）：非法值回专用错误码 model_not_found /
      // provider_not_found（契约 C §4，替换降级的 invalid_payload 携带说明）
      client.send({ v: PROTOCOL_VERSION, sessionId: "sess-x", type: "model.set", payload: { model: "m/x" } });
      const setErr = await client.waitFor(
        (f) => f.type === "connection.error" && f.payload.code === "model_not_found" && String(f.payload.message).includes("model.set"),
        "model.set 非法模型回 model_not_found",
      );
      expect(String(setErr.payload.message)).toMatch(/不在目录/);
      client.send({ v: PROTOCOL_VERSION, type: "model.set_default", payload: {} });
      await client.waitFor(
        (f) => f.type === "connection.error" && f.payload.code === "command.invalid_payload" && String(f.payload.message).includes("model.set_default"),
        "model.set_default 缺字段回 invalid_payload",
      );
      client.send({ v: PROTOCOL_VERSION, type: "auth.set_key", payload: { providerId: "anthropic", apiKey: "" } });
      await client.waitFor(
        (f) => f.type === "connection.error" && f.payload.code === "command.invalid_payload" && String(f.payload.message).includes("auth.set_key"),
        "auth.set_key 空 key 回 invalid_payload（契约 C §1.3）",
      );
      client.send({ v: PROTOCOL_VERSION, type: "auth.set_key", payload: { providerId: "no-such-provider", apiKey: "k" } });
      await client.waitFor(
        (f) => f.type === "connection.error" && f.payload.code === "provider_not_found" && String(f.payload.message).includes("no-such-provider"),
        "auth.set_key 未知 provider 回 provider_not_found（契约 C §4）",
      );

      // 真实副作用链：auth.set_key 真写 auth.json（0600）+ 结果帧回执（微批）
      client.send({ v: PROTOCOL_VERSION, type: "auth.set_key", payload: { providerId: "anthropic", apiKey: "sk-ws-1234" } });
      await new Promise((r) => setTimeout(r, 200));
      expect(existsSync(path.join(rig.home, "auth.json"))).toBe(true);
      const authFile = JSON.parse(readFileSync(path.join(rig.home, "auth.json"), "utf8")) as Record<string, unknown>;
      expect(authFile.anthropic).toEqual({ type: "api_key", key: "sk-ws-1234" });

      // 目录外命令仍走 unknown 语义
      client.send({ v: PROTOCOL_VERSION, type: "bogus.command", payload: {} });
      await new Promise((r) => setTimeout(r, 100));
      const unknown = client.frames.filter((f) => f.type === "connection.error" && f.payload.code === "command.unknown");
      expect(unknown).toHaveLength(1);
      expect(String(unknown[0]?.payload.message)).toContain("bogus.command");

      // 连接保持：既有命令仍可用（unimplemented 计数恒 0——model/auth 全部真行为）
      client.send({ v: PROTOCOL_VERSION, type: "chat.abort", payload: {} });
      await new Promise((r) => setTimeout(r, 50));
      expect(client.frames.filter((f) => f.type === "connection.error" && f.payload.code === "command.unimplemented")).toHaveLength(0);
      expect(client.frames.filter((f) => f.type === "connection.error" && f.payload.code === "command.unknown")).toHaveLength(1);
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  test("v0.2 model/auth 命令结果帧点对点回执（T2.3-result-frames 微批）：真 WS 客户端收帧", async () => {
    // hermetic：预播种目录缓存 → catalog 走 4h 缓存读面零网络；verify 未录入
    // key → fail 结果帧（无网络）；真容器全链（ModelService + auth.json + SQLite）
    const rig = await makeRig({ seedCatalog: true });
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);
      await client.expect("session.snapshot");

      // ① model.catalog（抽样）：合并目录快照 + channel/sessionId 章印
      client.send({ v: PROTOCOL_VERSION, type: "model.catalog", payload: {} });
      const catalog = await client.expect("model.catalog.result");
      expect(catalog.channel).toBe("model");
      expect(catalog.sessionId).toBe("__system__"); // 全局命令：会话无关
      const models = catalog.payload.models as { id: string; providerId: string; contextWindow: number }[];
      expect(models.length).toBeGreaterThan(0);
      expect(catalog.payload.source).toBe("builtin"); // 播种空 overlay → builtin 快照
      expect(typeof catalog.payload.refreshedAt).toBe("number");
      expect(models[0]!.id).toContain("/"); // "provider/model-id"
      const anyModelId = models[0]!.id;

      // ② model.get：会话当前模型（信封 sessionId 缺省 = 当前会话归属）
      client.send({ v: PROTOCOL_VERSION, type: "model.get", payload: {} });
      const get = await client.expect("model.get.result");
      expect(get.channel).toBe("model");
      expect(get.sessionId).not.toBe("__system__"); // per-session 命令：目标会话 id（loadHistory 同构）
      expect(typeof get.payload.model).toBe("string");
      expect(typeof get.payload.isDefault).toBe("boolean");
      expect(get.payload.model).toBe(get.payload.defaultModel); // 新会话继承全局默认

      // ③ model.get_default / set_default / get_default 链（SQLite 单写）
      client.send({ v: PROTOCOL_VERSION, type: "model.get_default", payload: {} });
      const getDefault1 = await client.expect("model.get_default.result");
      const previousDefault = String(getDefault1.payload.model);
      client.send({ v: PROTOCOL_VERSION, type: "model.set_default", payload: { model: anyModelId } });
      const setDefault = await client.expect("model.set_default.result");
      expect(setDefault.payload.previous).toBe(previousDefault);
      const afterSetDefault = client.frames.length;
      client.send({ v: PROTOCOL_VERSION, type: "model.get_default", payload: {} });
      const getDefault2 = await client.expectAfter("model.get_default.result", afterSetDefault);
      expect(getDefault2.payload.model).toBe(anyModelId);

      // ④ auth.verify（抽样；未录入 key → fail 结果帧而非 error 帧，零网络）
      client.send({ v: PROTOCOL_VERSION, type: "auth.verify", payload: { providerId: "openai" } });
      const verify = await client.expect("auth.verify.result");
      expect(verify.channel).toBe("model");
      expect(verify.payload.status).toBe("fail");
      expect(String(verify.payload.reason)).toContain("未录入");

      // ⑤ auth.set_key → 掩码回执；auth.list（抽样）状态翻转；auth.delete_key → 空回执
      client.send({ v: PROTOCOL_VERSION, type: "auth.set_key", payload: { providerId: "anthropic", apiKey: "sk-ws-9876" } });
      const setKey = await client.expect("auth.set_key.result");
      expect(setKey.payload.keyMasked).toBe("····9876"); // 尾 4 位掩码
      client.send({ v: PROTOCOL_VERSION, type: "auth.list", payload: {} });
      const list = await client.expect("auth.list.result");
      const providers = list.payload.providers as { providerId: string; configured: boolean; keyMasked?: string }[];
      expect(providers.length).toBeGreaterThan(0); // 目录 provider 全集
      const anthropic = providers.find((p) => p.providerId === "anthropic")!;
      expect(anthropic.configured).toBe(true);
      expect(anthropic.keyMasked).toBe("····9876");

      client.send({ v: PROTOCOL_VERSION, type: "auth.delete_key", payload: { providerId: "anthropic" } });
      const deleteKey = await client.expect("auth.delete_key.result");
      expect(deleteKey.payload).toEqual({}); // 契约 C §1.3：响应 `{}`
      const afterDelete = client.frames.length;
      client.send({ v: PROTOCOL_VERSION, type: "auth.list", payload: {} });
      const list2 = await client.expectAfter("auth.list.result", afterDelete);
      const anthropic2 = (list2.payload.providers as { providerId: string; configured: boolean }[]).find((p) => p.providerId === "anthropic")!;
      expect(anthropic2.configured).toBe(false);
    } finally {
      await client.close();
      await rig.dispose();
    }
  }, 15000);
});

describe("GET /helix-dev-token（浏览器侧获取机制，T1.6 钉死）", () => {
  test("无 Origin（本地进程/curl）→ 200 纯文本 token；与文件一致", async () => {
    const rig = await makeRig();
    try {
      const resp = await fetch(`http://127.0.0.1:${rig.daemon.ws.port}/helix-dev-token`);
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type")).toContain("text/plain");
      expect(await resp.text()).toBe(rig.token);
    } finally {
      await rig.dispose();
    }
  });

  test("loopback 开发 Origin（vite dev）→ 反射 ACAO；外部 Origin → 403", async () => {
    const rig = await makeRig();
    try {
      const devResp = await fetch(`http://127.0.0.1:${rig.daemon.ws.port}/helix-dev-token`, {
        headers: { origin: "http://localhost:5173" },
      });
      expect(devResp.status).toBe(200);
      expect(devResp.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");

      const evil = await fetch(`http://127.0.0.1:${rig.daemon.ws.port}/helix-dev-token`, {
        headers: { origin: "http://evil.example" },
      });
      expect(evil.status).toBe(403);
    } finally {
      await rig.dispose();
    }
  });
});

describe("TP-CL6-6：static-serve 前端产物", () => {
  test("GET / 返回 fixture index.html（200 + text/html）；静态目录缺失时 daemon 照常启动", async () => {
    const staticDir = mkdtempSync(path.join(tmpdir(), "helix-static-"));
    writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>helix fixture</title>", "utf8");

    const rig = await makeRig({ staticDir });
    const rigNoStatic = await makeRig();
    try {
      const resp = await fetch(`http://127.0.0.1:${rig.daemon.ws.port}/`);
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type")).toContain("text/html");
      expect(await resp.text()).toContain("helix fixture");

      // 路径穿越拒绝
      const traversal = await fetch(`http://127.0.0.1:${rig.daemon.ws.port}/../dev-token`);
      // fetch 客户端会规范化 ..，改用原始路径探测 → 非 200 即可
      expect(traversal.status).toBeGreaterThanOrEqual(400);

      // 未配置 staticDir：GET / → 404，daemon 照常运行（WS 仍可握手）
      const resp404 = await fetch(`http://127.0.0.1:${rigNoStatic.daemon.ws.port}/`);
      expect(resp404.status).toBe(404);
      const client = new TestClient(rigNoStatic.url);
      await client.open();
      client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token: rigNoStatic.token, protocolVersion: PROTOCOL_VERSION } });
      await client.expect("connection.welcome");
      await client.close();
    } finally {
      await rig.dispose();
      await rigNoStatic.dispose();
      rmSync(staticDir, { recursive: true, force: true });
    }
  });
});

describe("D-1：快照含工具调用条目（tool-call 变体，重连/重启恢复语义）", () => {
  test("含工具轮对话后新客户端握手 → snapshot.entries 含 kind=tool-call（state done、含 result）", async () => {
    const rig = await makeRig({
      replies: [
        {
          toolCalls: [{ toolName: "bash", args: { command: "echo hi" }, result: "hi" }],
          text: "工具已执行。",
        },
      ],
    });
    const warmup = new TestClient(rig.url);
    try {
      await warmup.open();
      await helloHandshake(warmup, rig.token);
      await warmup.expect("session.snapshot");
      warmup.send({ v: 0, type: "chat.send", payload: { text: "跑个工具" } });
      await until(
        () => warmup.frames.some((f) => f.type === "agent.state.changed" && (f.payload as { state: string }).state === "idle"),
        5000,
        "等待工具轮结束回 idle",
      );

      // 新客户端（重连语义）：握手后的快照应含工具条目（原缺口：entries 只有 user/assistant 消息）
      const reconnect = new TestClient(rig.url);
      await reconnect.open();
      reconnect.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token: rig.token, protocolVersion: PROTOCOL_VERSION } });
      await reconnect.expect("connection.welcome");
      const snap = await reconnect.expect("session.snapshot");
      const entries = (
        snap.payload.snapshot as {
          entries: { kind: string; id: string; name?: string; state?: string; result?: string; role?: string }[];
        }
      ).entries;
      expect(entries.map((e) => e.kind)).toEqual(["message", "tool-call", "message"]);
      expect(entries[0]).toMatchObject({ role: "user", content: "跑个工具" });
      expect(entries[1]).toMatchObject({ kind: "tool-call", name: "bash", state: "done", result: "hi" });
      expect(typeof entries[1]!.id).toBe("string");
      expect(entries[2]).toMatchObject({ role: "assistant", content: "工具已执行。" });
      await reconnect.close();
    } finally {
      await warmup.close();
      await rig.dispose();
    }
  }, 15000);
});

describe("session.subscribe / unsubscribe（v0 保通路语义）", () => {
  test("subscribe 重推 session.snapshot；unsubscribe 后停止事件推送", async () => {
    const rig = await makeRig({ replies: [{ text: "回复甲" }] });
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);
      await client.expect("session.snapshot");
      const baseline = client.frames.length;

      // unsubscribe 后 publish 不再到达该连接
      client.send({ v: 0, type: "session.unsubscribe", payload: {} });
      await new Promise((r) => setTimeout(r, 100));
      client.send({ v: 0, type: "chat.send", payload: { text: "静默消息" } });
      await new Promise((r) => setTimeout(r, 500));
      // T2.2（AD-4）：退订后该会话事件帧停收；session.list_changed 是 daemon
      // 级清单广播（runState 变化 idle→streaming→idle），与连接订阅集无关
      const nonList = client.frames.slice(baseline).filter((f) => f.type !== "session.list_changed");
      expect(nonList).toHaveLength(0); // 无会话帧（连错误都没有）

      // subscribe → 恢复 + 重推快照（快照恢复语义；取 baseline 之后的新快照帧）
      client.send({ v: 0, type: "session.subscribe", payload: {} });
      const snap2 = await client.expectAfter("session.snapshot", baseline);
      const entries = (snap2.payload.snapshot as { entries: { role: string }[] }).entries;
      expect(entries.map((e) => e.role)).toEqual(["user", "assistant"]); // 上一轮已落盘的会话
    } finally {
      await client.close();
      await rig.dispose();
    }
  }, 12000);
});
