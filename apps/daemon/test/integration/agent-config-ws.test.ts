import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { createPaths } from "../../src/infrastructure/paths";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID, type FrameVersion } from "@helix/protocol";

/**
 * M6 T3 agent.config 命令族全链集成（真组合根 + FakeAgentEngine + 真 SQLite
 * + loopback WS；模型目录走 builtin 读面零网络——hasModel 不触远端）：
 * - ① agent.config.list 全 kind / 单 kind → 结果帧数据（tools 全集+启停态；
 *   skills 含 source；diagnostics 坏文件上抛；model 槽位 null 形态）；
 * - ② agent.config.set_enabled 四路径：applied（含 agent.config.changed 广播
 *   发出断言）/ unknown-name skipped / model unknown-model skipped /
 *   model clear（changed name=null）；
 * - ③ 前置校验失败（非法 kind / 缺字段）→ connection.error invalid_payload。
 */

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

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  async expect(type: string, timeoutMs = 3000): Promise<Frame> {
    await until(() => this.frames.some((f) => f.type === type), timeoutMs, `等待帧 ${type}（已收：${this.frames.map((f) => f.type).join(",")}）`);
    return this.frames.find((f) => f.type === type)!;
  }

  /** afterIndex 之后的指定 type 首帧（区分同型帧新旧）。 */
  async expectAfter(type: string, afterIndex: number, timeoutMs = 3000): Promise<Frame> {
    await until(() => this.frames.slice(afterIndex).some((f) => f.type === type), timeoutMs, `等待新帧 ${type}`);
    return this.frames.slice(afterIndex).find((f) => f.type === type)!;
  }

  /** 等待 invalid_payload 回执（含命令名文案锚点）。 */
  async waitForInvalidPayload(cmdType: string, timeoutMs = 3000): Promise<Frame> {
    const at = this.frames.length;
    await until(
      () =>
        this.frames
          .slice(at)
          .some((f) => f.type === "connection.error" && f.payload.code === "command.invalid_payload"),
      timeoutMs,
      `等待 invalid_payload（${cmdType}）`,
    );
    const frame = this.frames.slice(at).find(
      (f) => f.type === "connection.error" && f.payload.code === "command.invalid_payload",
    )!;
    expect(String(frame.payload.message)).toContain(cmdType);
    return frame;
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}

/** hello 握手（T4：命中零条目内存草稿 → welcome.draft 时不推快照，显式订阅；同 ws-server.test 先例）。 */
async function helloHandshake(client: TestClient, token: string): Promise<void> {
  client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token, protocolVersion: PROTOCOL_VERSION } });
  await client.expect("connection.welcome");
  client.send({ v: 0, type: "session.subscribe", payload: {} });
}

async function until(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function tmpHome(): string {
  return mkdtempSync(path.join(tmpdir(), "helix-agent-config-it-"));
}

interface ProfileBlock {
  profileKind: string;
  tools: { name: string; enabled: boolean; snippet: string }[];
  skills: { name: string; description: string; filePath: string; source: string; enabled: boolean }[];
  diagnostics: { code: string; message: string; path: string; source: string }[];
  model: string | null;
}

interface Rig {
  home: string;
  daemon: Awaited<ReturnType<typeof createTestDaemon>>;
  token: string;
  url: string;
  dispose: () => Promise<void>;
}

/** 组合根装配（随机端口；user 层技能预播种：好技能 + 坏文件）。 */
async function makeRig(): Promise<Rig> {
  const home = tmpHome();
  const workspace = tmpHome(); // project 层根（toolCwd 注入定向 tmp，与 resource-wiring 同法）
  const goodDir = path.join(createPaths(home).skillsHome(), "hello-skill");
  mkdirSync(goodDir, { recursive: true });
  writeFileSync(
    path.join(goodDir, "SKILL.md"),
    "---\nname: hello-skill\ndescription: 问候技能\n---\n\n正文",
    "utf8",
  );
  const badDir = path.join(createPaths(home).skillsHome(), "broken-skill");
  mkdirSync(badDir, { recursive: true });
  // 坏文件：缺 description → invalid_metadata 诊断（不产技能不炸）
  writeFileSync(path.join(badDir, "SKILL.md"), "---\nname: broken-skill\n---\n\n正文", "utf8");

  const engine = new FakeAgentEngine({});
  const daemon = await createTestDaemon({
    home,
    engine,
    skipConfig: true,
    port: 0,
    cliInput: new PassThrough(),
    cliOutput: new PassThrough(),
    toolCwd: workspace,
    builtinSkillsDir: tmpHome(), // T5：空目录隔离随仓内置技能（恰等断言不感知 builtin 面）
  });
  const token = readFileSync(path.join(home, "dev-token"), "utf8");
  return {
    home,
    daemon,
    token,
    url: `ws://127.0.0.1:${daemon.ws.port}`,
    dispose: async () => {
      await daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}

const MAIN_TOOLS = [
  "bash",
  "read",
  "write",
  "edit",
  "grep",
  "web_search",
  "web_fetch",
  "agent_spawn",
  "agent_send",
  "agent_status",
  "browser",
];
const SUB_TOOLS = ["bash", "read", "write", "edit", "grep", "web_search", "web_fetch", "browser"]; // H-3：+browser（wire 转发通道接 daemon CDP 单例）
/** builtin 目录内模型（model-provider.DEFAULT_MODEL_ID 同源；hasModel 读面零网络）。 */
const ANY_MODEL = "anthropic/claude-sonnet-4-5";

describe("agent.config.list（v0.6 全局命令；点对点结果帧）", () => {
  test("① 全 kind：双块（tools 全集+启停态；skills 含 source；diagnostics 坏文件上抛；model null）", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);
      await client.expect("session.snapshot");

      client.send({ v: PROTOCOL_VERSION, type: "agent.config.list", payload: {} });
      const result = await client.expect("agent.config.list.result");
      expect(result.v).toBe(PROTOCOL_VERSION);
      expect(result.channel).toBe("agent");
      expect(result.sessionId).toBe(SYSTEM_SESSION_ID); // 全局命令：会话无关
      const profiles = result.payload.profiles as ProfileBlock[];
      expect(profiles).toHaveLength(2);
      const [main, sub] = profiles;
      expect(main!.profileKind).toBe("main-session");
      expect(main!.tools.map((t) => t.name)).toEqual(MAIN_TOOLS);
      expect(main!.tools.every((t) => t.enabled)).toBe(true); // 缺省无记录 = 全启用
      // tools 行 snippet 一句话说明（ToolPromptSnippets 注册表同源；M6 T4 补登）
      const bashRow = main!.tools.find((t) => t.name === "bash")!;
      expect(bashRow.snippet).toBe("在沙箱工作目录执行 shell 命令并返回输出");
      expect(main!.tools.every((t) => t.snippet.length > 0)).toBe(true);
      expect(main!.skills).toEqual([
        {
          name: "hello-skill",
          description: "问候技能",
          filePath: expect.stringContaining("hello-skill"),
          source: "user",
          enabled: true,
        },
      ]);
      expect(main!.diagnostics).toEqual([
        {
          code: expect.stringContaining("metadata"),
          message: expect.any(String),
          path: expect.stringContaining("broken-skill"),
          source: "user",
        },
      ]);
      expect(main!.model).toBeNull(); // 槽位未设 = null（非 undefined——JSON 面）
      expect(sub!.profileKind).toBe("subagent-worker");
      expect(sub!.tools.map((t) => t.name)).toEqual(SUB_TOOLS);
      expect(sub!.model).toBeNull();
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  test("② 单 kind：payload.profileKind 过滤 → 单块", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.list",
        payload: { profileKind: "subagent-worker" },
      });
      const result = await client.expect("agent.config.list.result");
      const profiles = result.payload.profiles as ProfileBlock[];
      expect(profiles).toHaveLength(1);
      expect(profiles[0]!.profileKind).toBe("subagent-worker");
      expect(profiles[0]!.tools.map((t) => t.name)).toEqual(SUB_TOOLS);
    } finally {
      await client.close();
      await rig.dispose();
    }
  });
});

describe("agent.config.set_enabled（v0.6 全局命令；四路径回执形态）", () => {
  test("③ applied：tool 禁用 → 结果帧 applied + agent.config.changed 广播 + 落库生效", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "main-session", resourceType: "tool", name: "grep", enabled: false },
      });
      const applied = await client.expect("agent.config.set_enabled.result");
      expect(applied.payload).toEqual({ status: "applied" });
      // applied → 广播发出（发起连接同收：daemon 级全局配置，订阅无关全连接）
      const changed = await client.expectAfter("agent.config.changed", client.frames.indexOf(applied));
      expect(changed.channel).toBe("agent");
      expect(changed.sessionId).toBe(SYSTEM_SESSION_ID);
      expect(changed.payload).toEqual({
        profileKind: "main-session",
        resourceType: "tool",
        name: "grep",
        enabled: false,
      });
      // 落库生效（合取面收窄；T2 刷新链既有测试面，此处只验数据域）
      expect(rig.daemon.resource.getEffectiveTools("main-session").includes("grep")).toBe(false);
      expect(rig.daemon.resource.getEffectiveTools("subagent-worker").includes("grep")).toBe(true);
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  test("④ unknown-name skipped：全集外名（subagent 禁 agent_spawn）→ skipped 回执 + 零广播零落库", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "subagent-worker", resourceType: "tool", name: "agent_spawn", enabled: false },
      });
      const skipped = await client.expect("agent.config.set_enabled.result");
      expect(skipped.payload).toEqual({ status: "skipped", reason: "unknown-name" });
      await new Promise((r) => setTimeout(r, 150));
      expect(client.frames.filter((f) => f.type === "agent.config.changed")).toHaveLength(0); // skipped 零广播
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  test("⑤ model unknown-model skipped：目录外模型 → skipped 回执 + 零广播（ModelService.setModel 先例）", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "main-session", resourceType: "model", name: "nope/no-such-model", enabled: true },
      });
      const skipped = await client.expect("agent.config.set_enabled.result");
      expect(skipped.payload).toEqual({ status: "skipped", reason: "unknown-model" });
      await new Promise((r) => setTimeout(r, 150));
      expect(client.frames.filter((f) => f.type === "agent.config.changed")).toHaveLength(0);
      expect(rig.daemon.resource.modelSlot("main-session")).toBeUndefined(); // 未落库
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  test("⑥⑦ model set/clear：set → applied+changed(name=id)；clear → applied+changed(name=null)；list 槽位往返", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      // set 槽位
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "subagent-worker", resourceType: "model", name: ANY_MODEL, enabled: true },
      });
      const set = await client.expect("agent.config.set_enabled.result");
      expect(set.payload).toEqual({ status: "applied" });
      const changedSet = await client.expectAfter("agent.config.changed", client.frames.indexOf(set));
      expect(changedSet.payload).toEqual({
        profileKind: "subagent-worker",
        resourceType: "model",
        name: ANY_MODEL,
        enabled: true,
      });
      expect(rig.daemon.resource.modelSlot("subagent-worker")).toBe(ANY_MODEL);

      // clear 槽位
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "subagent-worker", resourceType: "model", name: "-", enabled: false },
      });
      const clear = await client.expectAfter("agent.config.set_enabled.result", client.frames.indexOf(changedSet));
      expect(clear.payload).toEqual({ status: "applied" });
      const changedClear = await client.expectAfter("agent.config.changed", client.frames.indexOf(clear));
      expect(changedClear.payload).toEqual({
        profileKind: "subagent-worker",
        resourceType: "model",
        name: null, // clear = name null
        enabled: false,
      });
      expect(rig.daemon.resource.modelSlot("subagent-worker")).toBeUndefined();

      // list 槽位现状随写面往返（set → 读回 → clear → null）
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "main-session", resourceType: "model", name: ANY_MODEL, enabled: true },
      });
      await client.expectAfter("agent.config.set_enabled.result", client.frames.indexOf(changedClear));
      client.send({ v: PROTOCOL_VERSION, type: "agent.config.list", payload: { profileKind: "main-session" } });
      const list1 = await client.expectAfter("agent.config.list.result", client.frames.length - 1);
      expect((list1.payload.profiles as ProfileBlock[])[0]!.model).toBe(ANY_MODEL);
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "main-session", resourceType: "model", name: "-", enabled: false },
      });
      await client.expectAfter("agent.config.set_enabled.result", client.frames.length - 1);
      client.send({ v: PROTOCOL_VERSION, type: "agent.config.list", payload: { profileKind: "main-session" } });
      const list2 = await client.expectAfter("agent.config.list.result", client.frames.length - 1);
      expect((list2.payload.profiles as ProfileBlock[])[0]!.model).toBeNull();
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  test("⑧ skill applied：已装技能启停 → applied + changed(resourceType=skill)", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "main-session", resourceType: "skill", name: "hello-skill", enabled: false },
      });
      const applied = await client.expect("agent.config.set_enabled.result");
      expect(applied.payload).toEqual({ status: "applied" });
      const changed = await client.expectAfter("agent.config.changed", client.frames.indexOf(applied));
      expect(changed.payload).toEqual({
        profileKind: "main-session",
        resourceType: "skill",
        name: "hello-skill",
        enabled: false,
      });
    } finally {
      await client.close();
      await rig.dispose();
    }
  });
});

describe("agent.config 前置校验（payload 形状）", () => {
  test("⑨ 非法 kind / 缺字段 → connection.error{command.invalid_payload}（连接保持）", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "global", resourceType: "tool", name: "grep", enabled: false },
      });
      await client.waitForInvalidPayload("agent.config.set_enabled");

      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "main-session", resourceType: "hook", name: "steer", enabled: true },
      });
      await client.waitForInvalidPayload("agent.config.set_enabled");

      client.send({ v: PROTOCOL_VERSION, type: "agent.config.set_enabled", payload: { profileKind: "main-session" } });
      await client.waitForInvalidPayload("agent.config.set_enabled");

      client.send({ v: PROTOCOL_VERSION, type: "agent.config.list", payload: { profileKind: "bogus" } });
      await client.waitForInvalidPayload("agent.config.list");
    } finally {
      await client.close();
      await rig.dispose();
    }
  });
});
