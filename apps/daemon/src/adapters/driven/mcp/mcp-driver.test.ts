import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpClient, parseMcpLines } from "./McpClient";
import { McpRegistry } from "./McpRegistry";
import { createMcpTools } from "./mcp-tool";
import type { McpServerConfig } from "./types";

/**
 * mcp 驱动层单测：真子进程 stdio JSON-RPC 往返（假 server 脚本——
 * node 内置解释器，处理 initialize/tools/list/tools/call 三方法）。
 */

/** 假 MCP server 脚本：行式 JSON-RPC，按 method 分发。 */
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
    const name = msg.params.name;
    if (name === "fail") { send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "boom" }], isError: true } }); return; }
    if (name === "rpc-error") { send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "tool crashed" } }); return; }
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "called:" + name + ":" + JSON.stringify(msg.params.arguments ?? {}) }] } });
  } else {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found: " + msg.method } });
  }
}
`;

function fakeServerConfig(name: string, extra?: Partial<McpServerConfig>): McpServerConfig {
  const dir = `${tmpdir()}/helix-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(dir, { recursive: true });
  const script = path.join(dir, "fake-server.mjs");
  writeFileSync(script, FAKE_SERVER);
  return { name, command: process.execPath, args: [script], ...extra };
}

describe("parseMcpLines（纯函数）", () => {
  test("跨 chunk 行缓冲：半行残余 + 空行跳过", () => {
    const got: string[] = [];
    const rest1 = parseMcpLines('{"a":1}\n{"b"', (l) => got.push(l));
    expect(rest1).toBe('{"b"');
    const rest2 = parseMcpLines(':2}\n\n{"c":3}\n', (l) => got.push(l), rest1);
    expect(rest2).toBe("");
    expect(got).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });
});

describe("McpClient（真子进程往返）", () => {
  test("initialize + listTools + callTool 全链路", async () => {
    const client = new McpClient(fakeServerConfig("t1"), { timeoutMs: 10000 } as never);
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo", "ping"]);
    const result = await client.callTool("echo", { text: "hi" });
    expect(result.content[0]).toEqual({ type: "text", text: 'called:echo:{"text":"hi"}' });
    client.stop();
    expect(client.isReady()).toBe(false);
  });

  test("断线后在飞请求被拒 + 懒重连（再 call 重建）", async () => {
    const client = new McpClient(fakeServerConfig("t2"), { timeoutMs: 10000 } as never);
    await client.listTools();
    client.stop();
    await expect(client.callTool("echo", {})).rejects.toThrow();
    // 懒重连：stop 后再调用重新 spawn
    const tools = await client.listTools();
    expect(tools.length).toBe(2);
    client.stop();
  });

  test("工具级 JSON-RPC error：错误响应上抛", async () => {
    const client = new McpClient(fakeServerConfig("t3"), { timeoutMs: 10000 } as never);
    await client.connect();
    await expect(client.callTool("rpc-error", {})).rejects.toThrow("tool crashed");
    client.stop();
  });
});

describe("McpRegistry（多 server 生命周期）", () => {
  test("addServer 发现工具 + 状态订阅 + 命名空间路由", async () => {
    const registry = new McpRegistry();
    const events: string[] = [];
    registry.onStatusChange((s) => events.push(`${s.name}:${s.state}`));
    const status = await registry.addServer(fakeServerConfig("alpha"));
    expect(status.state).toBe("running");
    expect(status.toolCount).toBe(2);
    expect(events).toEqual(["alpha:connecting", "alpha:running"]);
    // 发现面
    expect(registry.discoveredTools().map((t) => `${t.server}__${t.definition.name}`)).toEqual([
      "alpha__echo",
      "alpha__ping",
    ]);
    // 命名空间调用
    const result = await registry.callNamespacedTool("alpha__echo", { text: "x" });
    expect(result.content[0]).toEqual({ type: "text", text: 'called:echo:{"text":"x"}' });
    // toolsOf
    expect(registry.toolsOf("alpha")[0]).toEqual({ name: "echo", description: "Echo back" });
    registry.stopAll();
  });

  test("addServer 失败降级：error 状态留痕不抛", async () => {
    const registry = new McpRegistry();
    const status = await registry.addServer({
      name: "bad",
      command: "/nonexistent-command-xyz",
      args: [],
      timeoutMs: 3000,
    });
    expect(status.state).toBe("error");
    expect(status.lastError).toBeTruthy();
    expect(registry.discoveredTools()).toEqual([]);
    registry.stopAll();
  });

  test("removeServer：stopped 广播 + 后续调用拒绝", async () => {
    const registry = new McpRegistry();
    await registry.addServer(fakeServerConfig("beta"));
    const events: string[] = [];
    registry.onStatusChange((s) => events.push(`${s.name}:${s.state}`));
    expect(registry.removeServer("beta")).toBe(true);
    expect(events).toEqual(["beta:stopped"]);
    await expect(registry.callNamespacedTool("beta__echo", {})).rejects.toThrow("不存在");
    expect(registry.removeServer("beta")).toBe(false); // 幂等
  });

  test("enabled=false：idle 不连接，调用拒绝", async () => {
    const registry = new McpRegistry();
    const status = await registry.addServer({ ...fakeServerConfig("off"), enabled: false });
    expect(status.state).toBe("idle");
    await expect(registry.callNamespacedTool("off__echo", {})).rejects.toThrow("停用");
    registry.stopAll();
  });

  test("testServer 试连不注册", async () => {
    const registry = new McpRegistry();
    const tools = await registry.testServer(fakeServerConfig("probe"));
    expect(tools.length).toBe(2);
    expect(registry.getStatuses()).toEqual([]); // 未注册
  });
});

describe("mcp-tool 适配器（schema 透传 + 执行转投）", () => {
  test("inputSchema 透传为 parameters + execute 命名空间调用", async () => {
    const registry = new McpRegistry();
    await registry.addServer(fakeServerConfig("gamma"));
    const [tool] = createMcpTools(registry.discoveredTools(), registry);
    expect(tool?.name).toBe("gamma__echo");
    expect(tool?.description).toBe("[mcp:gamma] Echo back");
    expect(tool?.parameters).toMatchObject({
      type: "object",
      properties: { text: { type: "string" } },
    });
    const result = await tool?.execute("call-1", { text: "z" }, undefined, undefined, {} as never);
    expect(result?.content).toEqual([{ type: "text", text: 'called:echo:{"text":"z"}' }]);
    registry.stopAll();
  });

  test("isError 结果转异常（CoreToolExecutor 归一前哨）", async () => {
    const registry = new McpRegistry();
    await registry.addServer(fakeServerConfig("delta"));
    const badTool = {
      server: "delta",
      definition: { name: "fail", description: "always fails" },
    };
    const [tool] = createMcpTools([badTool], registry);
    await expect(tool?.execute("call-2", {}, undefined, undefined, {} as never)).rejects.toThrow(
      "执行失败",
    );
    registry.stopAll();
  });

  test("缺 inputSchema：空对象 schema 兜底", async () => {
    const registry = new McpRegistry();
    await registry.addServer(fakeServerConfig("eps"));
    const [tool] = createMcpTools(
      [{ server: "eps", definition: { name: "ping", description: "Pong" } }],
      registry,
    );
    expect(tool?.parameters).toEqual({ type: "object", properties: {} });
    registry.stopAll();
  });
});
