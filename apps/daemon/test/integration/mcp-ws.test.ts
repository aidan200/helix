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
      // config.json 落盘断言（真文件读面）
      const saved = JSON.parse(readFileSync(path.join(home, "config.json"), "utf8")) as { mcpServers?: { name: string; command: string }[] };
      expect(saved.mcpServers?.map((s) => s.name)).toEqual(["fake"]);
      expect(saved.mcpServers?.[0]?.command).toBe(process.execPath);

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
      const savedAfterUpdate = JSON.parse(readFileSync(path.join(home, "config.json"), "utf8")) as { mcpServers?: { timeoutMs?: number }[] };
      expect(savedAfterUpdate.mcpServers?.[0]?.timeoutMs).toBe(45000);

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

      // ① list 块携带 server 行（运行态透传 + 缺省启用）
      client.send({ v: 0, type: "agent.config.list", payload: {} });
      const before = await client.expect("agent.config.list.result");
      const mainBefore = (before.payload.profiles as { profileKind: string; mcpServers?: { name: string; enabled: boolean; state: string; toolCount?: number }[] }[]).find((b) => b.profileKind === "main-session");
      expect(mainBefore?.mcpServers).toEqual([{ name: "fake", enabled: true, state: "running", toolCount: 2 }] as { name: string; enabled: boolean; state: string; toolCount?: number }[]);

      // ② 写面：mcp-server 关 → applied + changed 广播（resourceType=mcp-server）
      const toggleStart = client.frames.length;
      client.send({ v: 0, type: "agent.config.set_enabled", payload: { profileKind: "main-session", resourceType: "mcp-server", name: "fake", enabled: false } });
      const setResult = await client.expectAfter("agent.config.set_enabled.result", toggleStart);
      expect(setResult.payload.status).toBe("applied");
      const changed = await client.expectAfter("agent.config.changed", toggleStart);
      expect(changed.payload).toMatchObject({ profileKind: "main-session", resourceType: "mcp-server", name: "fake", enabled: false });

      // ③ 重拉：server 行 enabled=false，工具行仍在 catalog（toggle 域不缩）
      client.send({ v: 0, type: "agent.config.list", payload: {} });
      const after = await client.expectAfter("agent.config.list.result", client.frames.length - 1);
      const mainAfter = (after.payload.profiles as { profileKind: string; mcpServers?: { name: string; enabled: boolean }[]; tools: { name: string }[] }[]).find((b) => b.profileKind === "main-session");
      expect(mainAfter?.mcpServers).toEqual([{ name: "fake", enabled: false, state: "running", toolCount: 2 }] as { name: string; enabled: boolean; state: string; toolCount?: number }[]);
      expect(mainAfter?.tools.some((t) => t.name === "fake__echo")).toBe(true);

      // ④ kind 隔离：subagent-worker 块 server 行仍启用
      const subAfter = (after.payload.profiles as { profileKind: string; mcpServers?: { name: string; enabled: boolean }[] }[]).find((b) => b.profileKind === "subagent-worker");
      expect(subAfter?.mcpServers?.[0]).toMatchObject({ name: "fake", enabled: true });

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
});
