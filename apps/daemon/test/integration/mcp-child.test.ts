import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { InstanceClosureOutcome } from "../../src/application/services/InstanceRunner";
import { SubagentLauncher } from "../../src/adapters/driven/subagent/SubagentLauncher";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { AgentInstance } from "../../src/domain/agent/AgentInstance";
import type { McpServerConfig } from "../../src/adapters/driven/mcp/types";

/**
 * mcp 批子进程接入集成（mcpServersFor env 透传 + ChildMain 自建 registry）：
 * - ① launcher env 透传：mcpServersFor 有值 → HELIX_MCP_SERVERS_JSON 透传
 *   （launch 时刻现拍）；undefined / 空数组 → 不传键（零配置零开销）；
 * - ② 真子进程端到端：fake MCP server 子进程（calls.log 观测）+ spawn 快照
 *   tools 含 fake__echo + toolCall 剧本调用 → MCP 工具真执行（预热时序：
 *   await addServer 完成后 executor 注册表就位，resolveTools 硬校验通过）
 *   + closure done 收口 + server 子进程收尾（stopAll 无孤儿）。
 */

const fakeModel = {
  id: "model",
  name: "Fake Model",
  api: "anthropic-messages",
  provider: "fake",
  baseUrl: "http://localhost-unused",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0 },
  contextWindow: 100_000,
  maxTokens: 8192,
} as unknown as Model<any>;

const closureBlock = (summary: string) =>
  `<<<CLOSURE\n${JSON.stringify({ status: "done", summary, reportPath: null, findings: [], taskId: null })}\nCLOSURE>>>`;

/** fake MCP server 脚本：echo/ping 双工具；tools/call 追加观测日志（FAKE_CALLS_LOG env）。 */
const FAKE_SERVER = `
const callsLog = process.env.FAKE_CALLS_LOG;
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
    if (callsLog) { const fs = require("node:fs"); fs.appendFileSync(callsLog, msg.params.name + ":" + JSON.stringify(msg.params.arguments ?? {}) + "\\n"); }
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "called:" + msg.params.name }] } });
  } else {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
}
`;

const tmpRoots: string[] = [];
const tmpDir = (prefix: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
};
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

function makeInstance(id = "agent-1"): AgentInstance {
  return AgentInstance.create({
    instanceId: id,
    kind: "subagent",
    profileKind: "subagent-worker",
    sessionId: "s-mcp-child",
    createdAt: "2026-08-20T00:00:00.000Z",
  });
}

// ── ① launcher env 桩测（Bun.spawn 打桩——subagent-spawn-snapshot 先例） ──

interface SpawnCall {
  readonly cmd: readonly string[];
  readonly env: Record<string, string | undefined>;
}

function patchSpawn(capture: SpawnCall[]): void {
  const fakeProc = () =>
    ({
      pid: 41000 + Math.floor(Math.random() * 900),
      exited: Promise.resolve(0),
      stdout: (async function* () {})(),
      stdin: { write: () => true },
    }) as unknown as ReturnType<typeof Bun.spawn>;
  (Bun as unknown as { spawn: unknown }).spawn = (opts: {
    cmd: readonly string[];
    env: Record<string, string | undefined>;
  }) => {
    capture.push({ cmd: [...opts.cmd], env: { ...opts.env } });
    return fakeProc();
  };
}

describe("mcp 批子进程接入（mcpServersFor env 透传）", () => {
  test("① 有值透传 HELIX_MCP_SERVERS_JSON / undefined·空集不传键", () => {
    const real = Bun.spawn;
    const calls: SpawnCall[] = [];
    patchSpawn(calls);
    try {
      const servers: McpServerConfig[] = [{ name: "shadcn", command: "npx", args: ["shadcn@latest", "mcp"] }];
      const run = (mcpServersFor?: (k: string) => readonly McpServerConfig[] | undefined): Record<string, string | undefined> => {
        const launcher = new SubagentLauncher({
          profile: SubAgentProfile,
          model: fakeModel,
          apiKeys: {},
          toolCwd: process.cwd(),
          ...(mcpServersFor !== undefined ? { mcpServersFor } : {}),
        });
        launcher.launch(makeInstance(), "task");
        return calls[calls.length - 1]!.env;
      };
      // 有值 → 透传（JSON 逐字段）
      const env1 = run(() => servers);
      expect(JSON.parse(env1.HELIX_MCP_SERVERS_JSON!)).toEqual(servers);
      // 空数组 → 不传键（零 server 零开销）
      const env2 = run(() => []);
      expect("HELIX_MCP_SERVERS_JSON" in env2).toBe(false);
      // undefined（未装配 getter）→ 不传键
      const env3 = run(() => undefined);
      expect("HELIX_MCP_SERVERS_JSON" in env3).toBe(false);
      // 未注入 mcpServersFor → 不传键（既有测试形态不变）
      const env4 = run();
      expect("HELIX_MCP_SERVERS_JSON" in env4).toBe(false);
    } finally {
      (Bun as unknown as { spawn: unknown }).spawn = real;
    }
  });

  test("② 真子进程端到端：fake MCP server 工具真执行 + closure 收口", async () => {
    const home = tmpDir("helix-mcp-child-");
    const serverDir = tmpDir("helix-mcp-fake-srv-");
    const scriptPath = path.join(home, "script.json");
    const callsLog = path.join(home, "calls.log");
    writeFileSync(path.join(serverDir, "fake-server.mjs"), FAKE_SERVER);
    // 剧本：首 turn 调 fake__echo，次 turn closure 文本
    writeFileSync(scriptPath, JSON.stringify({
      replies: [closureBlock("done")],
      toolCall: { name: "fake__echo", args: { text: "hi-mcp" } },
    }));

    const servers: McpServerConfig[] = [
      {
        name: "fake",
        command: process.execPath,
        args: [path.join(serverDir, "fake-server.mjs")],
        env: { FAKE_CALLS_LOG: callsLog },
      },
    ];
    const closures: { instanceId: string; outcome: InstanceClosureOutcome }[] = [];
    const launcher = new SubagentLauncher({
      profile: SubAgentProfile,
      model: fakeModel,
      apiKeys: { fake: "explicit-key" },
      toolCwd: home,
      fakeEngineScript: scriptPath,
      // spawn 快照：工具集含 MCP 命名空间名（模拟父进程 catalog 现拍已含）
      spawnSnapshot: () => ({
        tools: [...SubAgentProfile.tools, "fake__echo", "fake__ping"],
        systemPrompt: "SUB base + 工具清单",
      }),
      mcpServersFor: () => servers,
      onLine: () => {},
    });
    launcher.setCallbacks({
      onInstanceEvent: () => {},
      onInstanceClosure: (instanceId, outcome) => closures.push({ instanceId, outcome }),
    });

    launcher.launch(makeInstance(), "调 MCP echo 工具");
    await new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        if (closures.length > 0) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - t0 > 20000) {
          clearInterval(timer);
          reject(new Error("等待 closure 超时"));
        }
      }, 20);
    });

    // closure done（装配成功 = resolveTools 硬校验过——预热时序保证）
    expect(closures[0]!.outcome.result).toBe("done");
    // MCP 工具真执行：fake server 收到 echo 调用（观测日志）
    const logged = readFileSync(callsLog, "utf8");
    expect(logged).toContain('echo:{"text":"hi-mcp"}');
  }, 30000);
});
