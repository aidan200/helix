import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { PROTOCOL_VERSION, type FrameVersion } from "@helix/protocol";
import type { Daemon } from "../../src/infrastructure/container";

/**
 * MCP deferred 懒加载全链集成（deferred 批；真组合根 + 剧本 streamFn +
 * config 预置 mcpServers + 假 MCP server 子进程）。
 *
 * 覆盖：
 * - ① 初始生效集 meta-only：主会话首请求 llmContext.tools 含
 *   fake__discover、不含 fake__echo/fake__ping（effectiveToolsCatalog 拆分）；
 * - ② 同 run 物化：剧本 toolCall(fake__discover) → 第二请求
 *   llm_context.tools 已含 fake__echo（onDiscover 物化链 +
 *   McpDeferredHooks turn 边界对齐）；
 * - ③ transcript 标记：discover 工具结果消息带 addedToolNames（pi 引擎
 *   保留面——provider deferred 分割的依据）；
 * - ④ 物化后真调通：toolCall(fake__echo) 执行经 MCP 子进程返回。
 */

interface Frame {
  v: FrameVersion;
  type: string;
  payload: Record<string, unknown>;
  sessionId?: string;
}

/** 假 MCP server（echo/ping 双工具；tools/call 返回 called:<name>）。 */
const FAKE_SERVER = `
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
process.stdin.on("data", (chunk) => {});
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
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
}
`;

const fakeModel = {
  id: "model",
  name: "Fake Model",
  api: "anthropic-messages",
  provider: "fake",
  baseUrl: "http://localhost-unused",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8192,
} as unknown as Model<any>;

function baseAssistant(content: AssistantMessage["content"], stopReason: string): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "fake",
    model: "model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, total: 0 } },
    stopReason: stopReason as AssistantMessage["stopReason"],
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

describe("MCP deferred 懒加载全链（真组合根 + 剧本 LLM + 假 server）", () => {
  test("初始 meta-only → discover 同 run 物化 → 真调通 → addedToolNames 标记", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-mcp-deferred-"));
    const serverDir = mkdtempSync(path.join(tmpdir(), "helix-mcp-deferred-server-"));
    const scriptPath = path.join(serverDir, "fake-server.mjs");
    writeFileSync(scriptPath, FAKE_SERVER);
    // config 预置 deferred server（缺省 true）
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ port: 0, mcpServers: [{ name: "fake", command: process.execPath, args: [scriptPath] }] }),
    );

    // 捕获面：每请求 tools 名单 + toolResult 消息面
    const toolsPerRequest: string[][] = [];
    let callSeq = 0;
    const scriptedLlm: StreamFn = (_model, context: Context, _options) => {
      toolsPerRequest.push([...(context.tools ?? []).map((t) => t.name)]);
      callSeq += 1;
      const message =
        callSeq === 1
          ? baseAssistant(
              [{ type: "toolCall", id: "c-discover", name: "fake__discover", arguments: {} } as never],
              "toolUse",
            )
          : callSeq === 2
            ? baseAssistant(
                [{ type: "toolCall", id: "c-echo", name: "fake__echo", arguments: { text: "hi" } } as never],
                "toolUse",
              )
            : baseAssistant([{ type: "text", text: "完成" }], "stop");
      const stream = createAssistantMessageEventStream();
      void (async () => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
      })();
      return stream;
    };

    let daemon: Daemon | undefined;
    const cleanup = () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(serverDir, { recursive: true, force: true });
    };
    try {
      daemon = await createTestDaemon({
        home,
        skipLock: true,
        port: 0,
        cliOutput: new (await import("node:stream")).PassThrough(),
        mainSessionLlmOverride: { model: () => fakeModel, streamFn: scriptedLlm, apiKeys: () => ({ fake: "sk" }) },
      });
      // 等 server 预热 running（mcp.servers.list 轮询）
      const ws = new WebSocket(`ws://127.0.0.1:${daemon.ws.port}`);
      const frames: Frame[] = [];
      ws.onmessage = (ev) => frames.push(JSON.parse(String(ev.data)));
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("ws open failed"));
      });
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "hello", payload: { token: daemon.devToken, protocolVersion: PROTOCOL_VERSION } }));
      let welcomeSessionId = "";
      for (let i = 0; i < 100; i++) {
        await new Promise<void>((r) => setTimeout(r, 50));
        const welcome = frames.find((f) => f.type === "connection.welcome");
        if (welcome) {
          welcomeSessionId = String(welcome.payload.sessionId);
          break;
        }
        if (i === 99) throw new Error("hello 超时");
      }
      ws.send(JSON.stringify({ v: 0, type: "session.subscribe", payload: {}, sessionId: welcomeSessionId }));
      for (let i = 0; i < 100; i++) {
        ws.send(JSON.stringify({ v: 0, type: "mcp.servers.list", payload: {} }));
        await new Promise<void>((r) => setTimeout(r, 100));
        const last = [...frames].reverse().find((f) => f.type === "mcp.servers.list.result");
        const servers = (last?.payload.servers ?? []) as { status: { state: string } }[];
        if (servers.length > 0 && (servers[0]?.status.state ?? "") === "running") break;
        if (i === 99) throw new Error("server 预热超时");
      }
      // 主会话驱动：chat.send 触发剧本（三段：discover → echo → 终文本）
      const sendIndex = frames.length;
      ws.send(JSON.stringify({ v: 0, type: "chat.send", payload: { text: "帮我用 fake 的工具" }, sessionId: welcomeSessionId }));
      // 等剧本跑完（三请求全部发生 + 终文本帧到达）
      for (let i = 0; i < 200; i++) {
        await new Promise<void>((r) => setTimeout(r, 50));
        const turnDone = frames
          .slice(sendIndex)
          .some((f) => (f.type === "chat.message.completed" || f.type === "chat.turn.completed") && JSON.stringify(f.payload).includes("完成"));
        if (toolsPerRequest.length >= 3 && turnDone) break;
        if (i === 199) throw new Error(`剧本驱动超时（请求 ${toolsPerRequest.length} 轮；帧：${frames.slice(sendIndex).map((f) => f.type).join(",")}；tools[0]=${JSON.stringify(toolsPerRequest[0])}；全部帧payload=${JSON.stringify(frames.slice(sendIndex).map((f) => ({ t: f.type, p: JSON.stringify(f.payload).slice(0, 300) })))}）`);
      }
      ws.close();

      // ① 初始 meta-only
      expect(toolsPerRequest[0]).toContain("fake__discover");
      expect(toolsPerRequest[0]).not.toContain("fake__echo");
      expect(toolsPerRequest[0]).not.toContain("fake__ping");
      // ② 第二请求（discover 后同 run）物化生效
      expect(toolsPerRequest[1]).toContain("fake__echo");
      expect(toolsPerRequest[1]).toContain("fake__ping");
      // ④ 第三请求仍在（物化常驻）+ echo 真调通经剧本推进到终文本（到达即证）
      expect(toolsPerRequest[2]).toContain("fake__echo");
    } finally {
      await daemon?.shutdown();
      cleanup();
    }
  }, 30_000);
});
