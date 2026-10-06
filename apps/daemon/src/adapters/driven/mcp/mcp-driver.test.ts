import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpClient } from "./McpClient";
import { McpRegistry } from "./McpRegistry";
import { createMcpDiscoverTools, createMcpTools, mcpDiscoverToolName } from "./mcp-tool";
import type { McpServerConfig } from "./types";
import { BACKGROUND_CONTEXT } from "../../../adapters/driven/tools/vendor/pi-harness";

/**
 * mcp 驱动层单测：真子进程 stdio JSON-RPC 往返（假 server 脚本——
 * node 内置解释器，处理 initialize/tools/list/tools/call 三方法）。
 *
 * 驱动层已薄壳化为 pi-mcp（@earendil-works/pi-mcp McpClient + StdioTransport）：
 * 协议/传输细节（行缓冲/分页/stdin error 兜底（TR-140 上游内建）/kill tree）
 * 由上游承担，本面测 helix 语义（懒重连/状态机/命名空间/适配器）。
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
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake-mcp-server", version: "0.0.1" } } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "echo", description: "Echo back", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
      { name: "ping", description: "Pong", inputSchema: { type: "object", properties: {} } },
    ] } });
  } else if (msg.method === "tools/call") {
    const name = msg.params.name;
    if (name === "fail") { send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "boom" }], isError: true } }); return; }
    if (name === "rpc-error") { send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "tool crashed" } }); return; }
    if (name === "split-utf8") {
      // M3 回归剧本：响应字节流在多字节字符中间切成两个 chunk（间隔 50ms
      // 保证不合并）——逐 chunk toString 的旧实现会产 U+FFFD 损坏 JSON
      const payload = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "你好世界🌍" }] } }) + "\\n";
      const buf = Buffer.from(payload, "utf-8");
      const cut = buf.indexOf(Buffer.from("你", "utf-8")) + 1; // 切在「你」三字节中间
      process.stdout.write(buf.subarray(0, cut));
      setTimeout(() => process.stdout.write(buf.subarray(cut)), 50);
      return;
    }
    if (name === "multimodal") { send({ jsonrpc: "2.0", id: msg.id, result: { content: [
      { type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", mimeType: "image/png" },
      { type: "audio", data: "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=", mimeType: "audio/wav" },
      { type: "resource", resource: { uri: "file:///tmp/big.bin", mimeType: "application/octet-stream", blob: "AAECAwQFBgcICQoLDA0ODw==" } },
    ] } }); return; }
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "called:" + name + ":" + JSON.stringify(msg.params.arguments ?? {}) }] } });
  } else {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found: " + msg.method } });
  }
}
`;

/** 假 server 脚本目录登记表（afterAll 统一回收——零残留卫生约定，见 e2e tmp-hygiene） */
const fakeServerDirs: string[] = [];

function fakeServerConfig(name: string, extra?: Partial<McpServerConfig>): McpServerConfig {
  const dir = `${tmpdir()}/helix-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(dir, { recursive: true });
  fakeServerDirs.push(dir);
  const script = path.join(dir, "fake-server.mjs");
  writeFileSync(script, FAKE_SERVER);
  return { name, command: process.execPath, args: [script], ...extra };
}

afterAll(() => {
  // 确定性泄漏回收：每用例一个 helix-mcp-test-* 脚本目录，不回收会在 CI 单 job
  // 串行布局里污染后续 e2e globalSetup 的 TMPDIR 卫生审计面（fail-fast 拦截）。
  for (const dir of fakeServerDirs) rmSync(dir, { recursive: true, force: true });
});

describe("McpClient（真子进程往返）", () => {
  test("initialize + listTools + callTool 全链路", async () => {
    const client = new McpClient(fakeServerConfig("t1"), { logger: undefined });
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo", "ping"]);
    const result = await client.callTool("echo", { text: "hi" });
    expect(result.content[0]).toEqual({ type: "text", text: 'called:echo:{"text":"hi"}' });
    client.stop();
    expect(client.isReady()).toBe(false);
  });

  test("stop 后调用懒重连（重建 client + transport）", async () => {
    const client = new McpClient(fakeServerConfig("t2"), { logger: undefined });
    await client.listTools();
    client.stop();
    // 懒重连：stop 后调用整体重建（pi-mcp client close 后不可复用）
    const tools = await client.listTools();
    expect(tools.length).toBe(2);
    client.stop();
  });

  test("工具级 JSON-RPC error：错误响应上抛", async () => {
    const client = new McpClient(fakeServerConfig("t3"), { logger: undefined });
    await client.connect();
    await expect(client.callTool("rpc-error", {})).rejects.toThrow("tool crashed");
    client.stop();
  });

  test("多字节字符跨 chunk 边界不损坏（Buffer 拼接，上游承担）", async () => {
    const client = new McpClient(fakeServerConfig("t-split"), { logger: undefined });
    const result = await client.callTool("split-utf8", {});
    expect(result.content[0]).toEqual({ type: "text", text: "你好世界🌍" }); // 无 U+FFFD、响应行未被丢弃
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

  test("懒重连成功后重新发现：error 滞留不丢工具面（F1 修复）", async () => {
    const registry = new McpRegistry();
    await registry.addServer(fakeServerConfig("reconn"));
    expect(registry.getStatuses()[0]?.state).toBe("running");
    // 模拟常驻进程意外退出：SIGKILL 子进程 → onExit 降级 error
    const sawError = new Promise<void>((resolve) => {
      registry.onStatusChange((s) => {
        if (s.name === "reconn" && s.state === "error") resolve();
      });
    });
    const entry = (registry as unknown as { servers: Map<string, { client: McpClient }> }).servers.get("reconn")!;
    process.kill(entry.client.pid!, "SIGKILL");
    await sawError;
    expect(registry.getStatuses()[0]?.state).toBe("error");
    expect(registry.discoveredTools()).toEqual([]); // 非 running 被过滤
    // 懒重连调用成功 → 触发重新发现，状态复位 running + 工具面恢复
    const result = await registry.callNamespacedTool("reconn__echo", { text: "back" });
    expect(result.content[0]).toEqual({ type: "text", text: 'called:echo:{"text":"back"}' });
    expect(registry.getStatuses()[0]?.state).toBe("running");
    expect(registry.discoveredTools().map((t) => t.definition.name)).toEqual(["echo", "ping"]);
    registry.stopAll();
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
    const result = await tool?.execute("call-1", { text: "z" }, undefined as never, {} as never, undefined as never, BACKGROUND_CONTEXT);
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
    await expect(tool?.execute("call-2", {}, undefined as never, {} as never, undefined as never, BACKGROUND_CONTEXT)).rejects.toThrow(
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

  test("image/audio/resource 块占位：二进制原文不进模型上下文（F1 修复）", async () => {
    const registry = new McpRegistry();
    await registry.addServer(fakeServerConfig("mm"));
    const [tool] = createMcpTools(
      [{ server: "mm", definition: { name: "multimodal", description: "returns media" } }],
      registry,
    );
    const result = await tool?.execute("call-mm", {}, undefined as never, {} as never, undefined as never, BACKGROUND_CONTEXT);
    const text = (result?.content[0] as { text: string }).text;
    expect(text).toContain("[image mimeType=image/png]");
    expect(text).toContain("[audio mimeType=audio/wav]");
    expect(text).toContain("[resource uri=file:///tmp/big.bin mimeType=application/octet-stream]");
    // base64 原文不透出
    expect(text).not.toContain("iVBORw0KGgo");
    expect(text).not.toContain("UklGRiQ");
    expect(text).not.toContain("AAECAwQFBgc");
    registry.stopAll();
  });
});

// ── deferred 批：meta 发现工具 ──────────────────────────────────────────

describe("mcpDiscoverToolName（撞名防御）", () => {
  test("无占用 → `${server}__discover`", () => {
    expect(mcpDiscoverToolName("shadcn", ["echo", "ping"])).toBe("shadcn__discover");
  });
  test("原生占用 discover → 退位 mcp_discover", () => {
    expect(mcpDiscoverToolName("x", ["discover", "echo"])).toBe("x__mcp_discover");
  });
  test("双占用 → undefined（调用方跳过退化急发）", () => {
    expect(mcpDiscoverToolName("x", ["discover", "mcp_discover"])).toBeUndefined();
  });
});

describe("createMcpDiscoverTool / createMcpDiscoverTools（真 registry）", () => {
  test("execute 返回清单 + onDiscover 回调", async () => {
    const registry = new McpRegistry();
    await registry.addServer(fakeServerConfig("fake"));
    const discovered: Array<[string, string[]]> = [];
    const { tools } = createMcpDiscoverTools(registry, {
      onDiscover: (server, names) => discovered.push([server, [...names]]),
    });
    expect(tools.map((t) => t.name)).toEqual(["fake__discover"]);
    const discover = tools[0]!;
    const result = await discover.execute("c1", {}, undefined as never, {} as never, undefined as never, BACKGROUND_CONTEXT);
    expect(result.content[0]).toMatchObject({ type: "text" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("fake__echo: Echo back");
    expect(discovered).toEqual([["fake", ["fake__echo", "fake__ping"]]]);
  });

  test("isToolEnabled 过滤：停用工具不物化不标记", async () => {
    const registry = new McpRegistry();
    await registry.addServer(fakeServerConfig("fake"));
    const { tools } = createMcpDiscoverTools(registry, {
      isToolEnabled: (name) => name !== "fake__ping",
      onDiscover: () => {},
    });
    const discover = tools[0]!;
    const result = await discover.execute("c1", {}, undefined as never, {} as never, undefined as never, BACKGROUND_CONTEXT);
    expect((result.content[0] as { text: string }).text).not.toContain("fake__ping");
  });

  test("deferred=false / enabled=false / 零工具 server 不生成 meta", async () => {
    const registry = new McpRegistry();
    await registry.addServer(fakeServerConfig("eager", { deferred: false }));
    await registry.addServer(fakeServerConfig("off", { enabled: false }));
    const { tools, skipped } = createMcpDiscoverTools(registry, {});
    expect(tools).toHaveLength(0);
    expect(skipped).toHaveLength(0);
  });

  test("双占用 server 进 skipped（退化急发路径）", async () => {
    const registry = new McpRegistry();
    // fakeServerConfig 的 fake server 固定 echo/ping——用脚本内联覆盖：直接
    // 构造带 discover/mcp_discover 的 server（复用 FAKE_SERVER 目录机制不便，
    // 这里以 registry 行为面测：toolsOf 返回固定名——用子类注入）。
    const entries = registry as unknown as { servers: Map<string, { config: McpServerConfig; client: object; status: object; tools: object[] }> };
    entries.servers.set("clash", {
      config: { name: "clash", command: "x" },
      client: {} as never,
      status: { name: "clash", state: "running", toolCount: 2 },
      tools: [
        { name: "discover", description: "原生" },
        { name: "mcp_discover", description: "原生" },
      ],
    });
    const { tools, skipped } = createMcpDiscoverTools(registry, {});
    expect(tools).toHaveLength(0);
    expect(skipped).toEqual(["clash"]);
  });
});
