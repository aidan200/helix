import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID, type FrameVersion } from "@helix/protocol";
import type { Daemon } from "../../src/infrastructure/container";

/**
 * mcp 族命令全链集成（mcp 批；真组合根 + FakeAgentEngine + 真 McpRegistry +
 * 假 MCP server 子进程——mcp-driver.test.ts 同款 fixture 脚本）：
 * - ① mcp.servers.list：空 config 起步 → servers=[]（registry 无条件构造，
 *   零配置 daemon 命令族可用——「add 首个 server」前置）；
 * - ② mcp.servers.add：applied 判别（state=running + toolCount）+
 *   config.json mcpServers 段落盘断言 + mcp.status.changed 广播回流；
 * - ③ add connect 失败：connect_failed 判别 + 配置保留（list 含 error 行，
 *   可重试语义）；
 * - ④ add 名字冲突 → connection.error invalid_payload；
 * - ⑤ mcp.tools.list：命名空间后全名（fake__echo 形态）；
 * - ⑥ mcp.servers.test：applied{toolCount} / 坏命令 failed{error}（不落盘）；
 * - ⑦ mcp.servers.update：覆盖重连 applied；
 * - ⑧ mcp.servers.remove：applied + config 滤行 + stopped 广播；
 * - ⑨ 工具面生效真链路：add 成功后 agent.config.list tools 含 mcp 命名空间
 *   工具名（catalog 动态拼接——ResourceService 现拍 McpRegistry）。
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

  async expect(type: string, timeoutMs = 5000): Promise<Frame> {
    await until(() => this.frames.some((f) => f.type === type), timeoutMs, `等待帧 ${type}（已收：${this.frames.map((f) => f.type).join(",")}）`);
    return this.frames.find((f) => f.type === type)!;
  }

  /** afterIndex 之后的指定 type 首帧（区分同型帧新旧）。 */
  async expectAfter(type: string, afterIndex: number, timeoutMs = 5000): Promise<Frame> {
    await until(() => this.frames.slice(afterIndex).some((f) => f.type === type), timeoutMs, `等待新帧 ${type}`);
    return this.frames.slice(afterIndex).find((f) => f.type === type)!;
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}

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

/** 假 MCP server 脚本（mcp-driver.test.ts 同款：echo/ping 双工具）。 */
const FAKE_SERVER = `
const lines = [];
let buf = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(JSON.parse(line));
  }
});
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
function handle(msg) {
  if (msg.id === undefined) return;
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} } } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "echo", description: "Echo back", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
      { name: "ping", description: "Pong" },
    ] } });
  } else if (msg.method === "tools/call") {
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "called:" + msg.params.name }] } });
  } else {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found: " + msg.method } });
  }
}
`;

interface FakeServerRef {
  readonly input: Record<string, unknown>;
  readonly scriptPath: string;
}

function fakeServerInput(name: string, extra?: Record<string, unknown>): FakeServerRef {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-mcp-ws-it-"));
  const scriptPath = path.join(dir, "fake-server.mjs");
  writeFileSync(scriptPath, FAKE_SERVER);
  return { input: { name, command: process.execPath, args: [scriptPath], ...extra }, scriptPath };
}

/** mcp_server 表读面（config 瘦身批：声明面落 helix.db；只读连接零 DML）。 */
function readMcpTable(home: string): { name: string; config: string }[] {
  const { Database } = require("bun:sqlite");
  const db = new Database(path.join(home, "helix.db"), { readonly: true });
  try {
    return db.prepare("SELECT name, config FROM mcp_server ORDER BY position").all() as { name: string; config: string }[];
  } finally {
    db.close();
  }
}

describe("mcp 族命令全链（真组合根 + 假 server 子进程）", () => {
  test("①-⑧ CRUD 全链：空起步 → add → list/tools/test/update/remove + 失败语义", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-mcp-ws-home-"));
    let daemon: Daemon | undefined;
    let client: TestClient | undefined;
    try {
      daemon = await createTestDaemon({ home, engine: new FakeAgentEngine(), skipLock: true, port: 0 });
      client = new TestClient(`ws://127.0.0.1:${daemon.ws.port}`);
      await client.open();
      await helloHandshake(client, daemon.devToken);

      // ① 空 config 起步：list → servers=[]（registry 无条件构造）
      client.send({ v: 0, type: "mcp.servers.list", payload: {} });
      const listEmpty = await client.expect("mcp.servers.list.result");
      expect(listEmpty.payload.servers).toEqual([]);

      // ② add：applied + running + toolCount=2 + 落盘 + 广播回流
      const fake = fakeServerInput("fake");
      const connectStart = client.frames.length;
      client.send({ v: 0, type: "mcp.servers.add", payload: fake.input });
      const addResult = await client.expect("mcp.servers.add.result");
      expect(addResult.payload.status).toBe("applied");
      expect(addResult.payload.server).toMatchObject({ name: "fake", state: "running", toolCount: 2 });
      // 广播回流（connecting/running 至少 running 一帧；SYSTEM_SESSION_ID 盖章）
      const statusFrame = await client.expectAfter("mcp.status.changed", connectStart, 8000);
      expect(statusFrame.sessionId).toBe(SYSTEM_SESSION_ID);
      expect(statusFrame.payload.server).toMatchObject({ name: "fake" });
      // mcp_server 表落盘断言（config 瘦身批：声明面迁表；真库读面）
      const savedRows = readMcpTable(home);
      expect(savedRows.map((r) => r.name)).toEqual(["fake"]);
      expect(JSON.parse(savedRows[0]!.config).command).toBe(process.execPath);

      // ⑨ 工具面生效真链路：agent.config.list tools 含命名空间工具名
      client.send({ v: 0, type: "agent.config.list", payload: {} });
      const roster = await client.expect("agent.config.list.result");
      const tools = JSON.stringify(roster.payload);
      expect(tools).toContain("fake__echo");
      expect(tools).toContain("fake__ping");

      // ⑤ tools.list：命名空间后全名
      client.send({ v: 0, type: "mcp.tools.list", payload: { server: "fake" } });
      const toolsList = await client.expect("mcp.tools.list.result");
      expect(toolsList.payload.tools).toEqual([
        { name: "fake__echo", description: "Echo back" },
        { name: "fake__ping", description: "Pong" },
      ]);

      // ⑥ test：applied toolCount；不落盘（list 不变）
      const probe = fakeServerInput("probe-only");
      client.send({ v: 0, type: "mcp.servers.test", payload: probe.input });
      const testOk = await client.expect("mcp.servers.test.result");
      expect(testOk.payload).toMatchObject({ status: "applied", toolCount: 2 });
      client.send({ v: 0, type: "mcp.servers.list", payload: {} });
      const listAfterTest = await client.expectAfter("mcp.servers.list.result", client.frames.length - 1);
      expect((listAfterTest.payload.servers as unknown[]).length).toBe(1); // probe-only 不落盘

      // ④ add 名字冲突 → connection.error
      const dupStart = client.frames.length;
      client.send({ v: 0, type: "mcp.servers.add", payload: { name: "fake", command: "x" } });
      const dupErr = await client.expectAfter("connection.error", dupStart);
      expect(dupErr.payload.code).toBe("command.invalid_payload");

      // ⑦ update：覆盖重连 applied（enabled 段变化）
      client.send({ v: 0, type: "mcp.servers.update", payload: { ...fake.input, timeoutMs: 45000 } });
      const updateResult = await client.expect("mcp.servers.update.result");
      expect(updateResult.payload.status).toBe("applied");
      expect(updateResult.payload.server).toMatchObject({ name: "fake", state: "running" });
      expect(JSON.parse(readMcpTable(home)[0]!.config).timeoutMs).toBe(45000);

      // ⑧ remove：applied + 滤行 + stopped 广播
      const removeStart = client.frames.length;
      client.send({ v: 0, type: "mcp.servers.remove", payload: { name: "fake" } });
      const removeResult = await client.expectAfter("mcp.servers.remove.result", removeStart);
      expect(removeResult.payload).toMatchObject({ status: "applied", server: { name: "fake", state: "stopped" } });
      const stoppedFrame = await client.expectAfter("mcp.status.changed", removeStart, 8000);
      expect(stoppedFrame.payload.server).toMatchObject({ name: "fake", state: "stopped" });
      const savedAfterRemove = JSON.parse(readFileSync(path.join(home, "config.json"), "utf8")) as { mcpServers?: unknown[] };
      expect(savedAfterRemove.mcpServers).toBeUndefined(); // 空数组 → 段省略
    } finally {
      await client?.close();
      await daemon?.shutdown();
      rmSync(home, { recursive: true, force: true });
    }
  }, 30000);

  test("③ add connect 失败：connect_failed 判别 + 配置保留（可重试）", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-mcp-ws-home-"));
    let daemon: Daemon | undefined;
    let client: TestClient | undefined;
    try {
      daemon = await createTestDaemon({ home, engine: new FakeAgentEngine(), skipLock: true, port: 0 });
      client = new TestClient(`ws://127.0.0.1:${daemon.ws.port}`);
      await client.open();
      await helloHandshake(client, daemon.devToken);

      // 坏命令：spawn 失败 → connect_failed + 配置已落盘（list 含 error 行）
      client.send({ v: 0, type: "mcp.servers.add", payload: { name: "broken", command: "definitely-not-a-command-xyz" } });
      const addResult = await client.expect("mcp.servers.add.result", 15000);
      expect(addResult.payload.status).toBe("connect_failed");
      expect(addResult.payload.server).toMatchObject({ name: "broken", state: "error" });
      expect(typeof addResult.payload.error).toBe("string");

      client.send({ v: 0, type: "mcp.servers.list", payload: {} });
      const list = await client.expect("mcp.servers.list.result");
      const servers = list.payload.servers as { config: { name: string }; status: { state: string } }[];
      expect(servers).toHaveLength(1);
      expect(servers[0]?.status).toMatchObject({ name: "broken", state: "error" });

      // test 坏命令 → failed 判别（不落盘——list 仍一行）
      client.send({ v: 0, type: "mcp.servers.test", payload: { name: "broken2", command: "nope-xyz" } });
      const testFailed = await client.expect("mcp.servers.test.result", 15000);
      expect(testFailed.payload.status).toBe("failed");
      expect(typeof testFailed.payload.error).toBe("string");
    } finally {
      await client?.close();
      await daemon?.shutdown();
      rmSync(home, { recursive: true, force: true });
    }
  }, 30000);

  test("⑩ server 级配置面：per-kind server 开关全链（list 行/写面/广播/门控语义）", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-mcp-ws-home-"));
    let daemon: Daemon | undefined;
    let client: TestClient | undefined;
    try {
      daemon = await createTestDaemon({ home, engine: new FakeAgentEngine(), skipLock: true, port: 0 });
      client = new TestClient(`ws://127.0.0.1:${daemon.ws.port}`);
      await client.open();
      await helloHandshake(client, daemon.devToken);

      // 前置：add fake → running
      const fake = fakeServerInput("fake");
      client.send({ v: 0, type: "mcp.servers.add", payload: fake.input });
      const addResult = await client.expect("mcp.servers.add.result", 10000);
      expect(addResult.payload.status).toBe("applied");

      // ① list 块携带 server 行（运行态透传；同轨批：缺省禁）
      client.send({ v: 0, type: "agent.config.list", payload: {} });
      const before = await client.expect("agent.config.list.result");
      const mainBefore = (before.payload.profiles as { profileKind: string; mcpServers?: { name: string; enabled: boolean; state: string; toolCount?: number }[] }[]).find((b) => b.profileKind === "main-session");
      expect(mainBefore?.mcpServers).toEqual([{ name: "fake", enabled: false, state: "running", toolCount: 2 }] as { name: string; enabled: boolean; state: string; toolCount?: number }[]);

      // ② 写面：mcp-server 启 → applied + changed 广播（resourceType=mcp-server）
      const toggleStart = client.frames.length;
      client.send({ v: 0, type: "agent.config.set_enabled", payload: { profileKind: "main-session", resourceType: "mcp-server", name: "fake", enabled: true } });
      const setResult = await client.expectAfter("agent.config.set_enabled.result", toggleStart);
      expect(setResult.payload.status).toBe("applied");
      const changed = await client.expectAfter("agent.config.changed", toggleStart);
      expect(changed.payload).toMatchObject({ profileKind: "main-session", resourceType: "mcp-server", name: "fake", enabled: true });

      // ③ 重拉：server 行 enabled=true，工具行仍在 catalog（toggle 域不缩）
      client.send({ v: 0, type: "agent.config.list", payload: {} });
      const after = await client.expectAfter("agent.config.list.result", client.frames.length - 1);
      const mainAfter = (after.payload.profiles as { profileKind: string; mcpServers?: { name: string; enabled: boolean }[]; tools: { name: string }[] }[]).find((b) => b.profileKind === "main-session");
      expect(mainAfter?.mcpServers).toEqual([{ name: "fake", enabled: true, state: "running", toolCount: 2 }] as { name: string; enabled: boolean; state: string; toolCount?: number }[]);
      expect(mainAfter?.tools.some((t) => t.name === "fake__echo")).toBe(true);

      // ④ kind 隔离：subagent-worker 无差异行 → 默认禁（main 启用不联动）
      const subAfter = (after.payload.profiles as { profileKind: string; mcpServers?: { name: string; enabled: boolean }[] }[]).find((b) => b.profileKind === "subagent-worker");
      expect(subAfter?.mcpServers?.[0]).toMatchObject({ name: "fake", enabled: false });

      // ⑤ 未配置 server 名 → skipped（不落库不广播）
      const ghostStart = client.frames.length;
      client.send({ v: 0, type: "agent.config.set_enabled", payload: { profileKind: "main-session", resourceType: "mcp-server", name: "ghost", enabled: false } });
      const ghostResult = await client.expectAfter("agent.config.set_enabled.result", ghostStart);
      expect(ghostResult.payload).toMatchObject({ status: "skipped", reason: "unknown-mcp-server" });
    } finally {
      await client?.close();
      await daemon?.shutdown();
      rmSync(home, { recursive: true, force: true });
    }
  }, 30000);

  test("⑪ 编排 MCP 面（编排归位批）：orchestrator 系统块携带只读 server 行（kind 缺省禁）+ 写面 read_only 拒绝 + main/sub 不受影响", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-mcp-ws-home-"));
    let daemon: Daemon | undefined;
    let client: TestClient | undefined;
    try {
      daemon = await createTestDaemon({ home, engine: new FakeAgentEngine(), skipLock: true, port: 0 });
      client = new TestClient(`ws://127.0.0.1:${daemon.ws.port}`);
      await client.open();
      await helloHandshake(client, daemon.devToken);

      // 前置：add fake → running
      client.send({ v: 0, type: "mcp.servers.add", payload: fakeServerInput("fake").input });
      const addResult = await client.expect("mcp.servers.add.result", 10000);
      expect(addResult.payload.status).toBe("applied");

      // ① orchestrator 系统块：只读 server 行（kind 缺省禁用 = 变相禁用展示）+
      // 声明全集工具行（含 MCP 命名空间名的展示行）
      client.send({ v: 0, type: "agent.config.list", payload: {} });
      const before = await client.expect("agent.config.list.result");
      const orch = (before.payload.system as { profileKind: string; mcpServers?: { name: string; enabled: boolean; state: string; toolCount?: number }[]; tools: { name: string }[] }[]).find((b) => b.profileKind === "orchestrator");
      expect(orch?.mcpServers).toEqual([{ name: "fake", enabled: false, state: "running", toolCount: 2 }] as { name: string; enabled: boolean; state: string; toolCount?: number }[]);
      expect(orch?.tools.some((t) => t.name === "fake__echo")).toBe(true);
      // 同轨批：main/sub profiles 块 server 行同缺省禁（全 kind 显式启用制）
      const profiles = before.payload.profiles as { profileKind: string; mcpServers?: { name: string; enabled: boolean }[] }[];
      expect(profiles.find((b) => b.profileKind === "main-session")?.mcpServers?.[0]).toMatchObject({ name: "fake", enabled: false });

      // ② 写面：orchestrator mcp-server/tool/skill 启停 → read_only 拒绝（系统 kind 仅槽位型可写）
      client.send({ v: 0, type: "agent.config.set_enabled", payload: { profileKind: "orchestrator", resourceType: "mcp-server", name: "fake", enabled: true } });
      await until(
        () => client!.frames.some((f) => f.type === "connection.error" && f.payload.code === "agent.config.read_only"),
        3000,
        "等待 read_only 拒绝（orchestrator mcp-server）",
      );

      // ③ 重拉：orchestrator 行仍 enabled=false（无差异行落库）
      client.send({ v: 0, type: "agent.config.list", payload: {} });
      const after = await client.expectAfter("agent.config.list.result", client.frames.length - 1);
      const orchAfter = (after.payload.system as { profileKind: string; mcpServers?: { name: string; enabled: boolean }[] }[]).find((b) => b.profileKind === "orchestrator");
      expect(orchAfter?.mcpServers?.[0]).toMatchObject({ name: "fake", enabled: false });
    } finally {
      await client?.close();
      await daemon?.shutdown();
      rmSync(home, { recursive: true, force: true });
    }
  }, 30000);
  test("⑫ builtin 技能差异行播种（缺省启停批）：真 builtin 源开箱 enabled=true + 重启持久化幂等 + 用户显式关闭不被覆盖", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-mcp-ws-home-"));
    const listBuiltinRows = async (client: TestClient, kind: string) => {
      client.send({ v: 0, type: "agent.config.list", payload: { profileKind: kind } });
      const res = await client.expect("agent.config.list.result");
      const block = (res.payload.profiles as { profileKind: string; skills?: { name: string; source: string; enabled: boolean }[] }[])[0];
      return block?.skills?.filter((s) => s.source === "builtin") ?? [];
    };
    try {
      // ① 真组合根（未传 builtinSkillsDir——随仓 resources/skills 真源）：
      // agent 层 builtin（plan-workflow/web-access）开箱 enabled=true（播种行）
      let daemon = await createTestDaemon({ home, engine: new FakeAgentEngine(), skipLock: true, port: 0 });
      let client = new TestClient(`ws://127.0.0.1:${daemon.ws.port}`);
      await client.open();
      await helloHandshake(client, daemon.devToken);
      const mainRows = await listBuiltinRows(client, "main-session");
      expect(mainRows.length).toBeGreaterThanOrEqual(2); // plan-workflow + web-access
      expect(mainRows.every((r) => r.enabled)).toBe(true); // 播种：缺行才播 true
      expect(mainRows.map((r) => r.name)).toContain("plan-workflow");
      // sub 块同构（可写 kind 全播）；user 层零行不碰
      const subRows = await listBuiltinRows(client, "subagent-worker");
      expect(subRows.every((r) => r.enabled)).toBe(true);
      // 用户显式关闭 plan-workflow（main）
      client.send({ v: 0, type: "agent.config.set_enabled", payload: { profileKind: "main-session", resourceType: "skill", name: "plan-workflow", enabled: false } });
      await client.expect("agent.config.set_enabled.result");
      await client.close();
      await daemon.shutdown();

      // ② 重启同 home（真持久化）：用户关过的行不被播种覆盖；其余 builtin 行仍在
      daemon = await createTestDaemon({ home, engine: new FakeAgentEngine(), skipLock: true, port: 0 });
      client = new TestClient(`ws://127.0.0.1:${daemon.ws.port}`);
      await client.open();
      await helloHandshake(client, daemon.devToken);
      const afterRestart = await listBuiltinRows(client, "main-session");
      expect(afterRestart.find((r) => r.name === "plan-workflow")?.enabled).toBe(false); // 用户行优先
      expect(afterRestart.find((r) => r.name === "web-access")?.enabled).toBe(true); // 播种行持久
      await client.close();
      await daemon.shutdown();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30000);
});
