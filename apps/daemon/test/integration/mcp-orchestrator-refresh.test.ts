import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Daemon } from "../../src/infrastructure/container";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";

/**
 * F4 修复③：MCP server running/stopped 状态变更的装配刷新链补 orchestrator
 * （container.ts onStatusChange 曾只刷 main-session/subagent-worker 两 kind，
 * orchestrator 组装快照永不随 MCP 到位重算——orchestratorMcpTools 注入面
 * 每会话现拍注册工具实例，快照 tools 名单却无 MCP 名：注册而不可达）。
 *
 * 观测面设计（隔离资源 toggle 刷新链——只证 MCP 状态链）：
 * - 启动前预置 helix.db：resource_state 差异行（orchestrator mcp-server fake
 *   enabled=1，WS 写面对 orchestrator read_only，差异行只能预置）+ mcp_server
 *   声明行（启动预热连接，免 WS add）；
 * - 启动时序保证：buildSessionStack 的启动快照先于 MCP 预热（fire-and-forget）
 *   ——初始 orchestratorAssembly 必无 fake__ 名；server 到 running 后唯一
 *   能让快照重算的链就是本修复接的 onStatusChange → refreshAssembly；
 * - 观测 = 任务 kickoff 时编排会话 streamFn 第二参 tools 名单（组装快照的
 *   唯一消费点）：轮询建任务直到快照出现 fake__discover（deferred meta 名）。
 * 未修复时快照停在启动值，轮询超时即红。
 */

const tmpRoots: string[] = [];
const tmpDir = (prefix: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
};
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

/** 假 MCP server 脚本（mcp-ws.test.ts 同款：echo/ping 双工具，stdio JSON-RPC）。 */
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

/** 任务类型 fixture（builtin task 层：TaskSkillRegistry 装载源；confirm skip 单阶段）。 */
const FAKE_TASK_SKILL = `---
name: fake-task
description: MCP 刷新链观测用测试任务类型
task:
  paramsSchema:
    projectRoot: { type: string, required: true }
  stages:
    strategy: fixed
    list: [执行]
  confirm: skip
  plan: optional
  projects: { min: 1, max: 1 }
---

# fake-task：观测用 SOP
`;

const fakeModel = {
  id: "model",
  name: "Fake Model",
  api: "anthropic-messages",
  provider: "fake",
  baseUrl: "http://localhost-unused",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8192,
} as unknown as Model<any>;

/** 捕获型编排 streamFn：记录每次 kickoff 的 tools 名单，回一句文本收轮。 */
function makeCapturingStreamFn(seen: Array<{ tools: string[] }>): StreamFn {
  return (model: Model<any>, context) => {
    const ctx = context as unknown as { tools?: Array<{ name: string }> };
    seen.push({ tools: (ctx.tools ?? []).map((t) => t.name) });
    const stream = createAssistantMessageEventStream();
    const final: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    } as unknown as AssistantMessage;
    void (async () => {
      stream.push({ type: "start", partial: final });
      stream.push({ type: "text_end", contentIndex: 0, content: "ok", partial: final });
      stream.push({ type: "done", reason: "stop", message: final });
    })();
    return stream;
  };
}

/** 启动前预置 helix.db：resource_state 差异行 + mcp_server 声明行（schema IF NOT EXISTS 与 daemon 启动 DDL 兼容）。 */
function preseedDb(home: string, serverConfig: Record<string, unknown>): void {
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(path.join(home, "helix.db"));
  try {
    db.run(`CREATE TABLE IF NOT EXISTS resource_state (
      profile_kind TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (profile_kind, resource_type, name)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS mcp_server (
      name TEXT PRIMARY KEY,
      config TEXT NOT NULL,
      position INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    const now = "2026-09-07T00:00:00.000Z";
    db.run(
      "INSERT INTO resource_state (profile_kind, resource_type, name, enabled, updated_at) VALUES ('orchestrator', 'mcp-server', 'fake', 1, ?)",
      [now],
    );
    db.run("INSERT INTO mcp_server (name, config, position, updated_at) VALUES ('fake', ?, 0, ?)", [
      JSON.stringify(serverConfig),
      now,
    ]);
  } finally {
    db.close();
  }
}

async function until(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`until 超时：${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("F4 修复③：MCP 到位 → orchestrator 组装快照随状态链刷新", () => {
  test("server running 后新编排会话快照含 fake__discover（修复前快照停启动值永不到达）", async () => {
    const home = tmpDir("helix-mcp-orch-refresh-");
    const serverDir = tmpDir("helix-mcp-orch-srv-");
    const serverScript = path.join(serverDir, "fake-server.mjs");
    writeFileSync(serverScript, FAKE_SERVER);
    // builtin 任务技能 fixture（TaskSkillRegistry 装载源——createTask 类型合法性前置）
    const builtinDir = tmpDir("helix-mcp-orch-skills-");
    mkdirSync(path.join(builtinDir, "task", "fake-task"), { recursive: true });
    writeFileSync(path.join(builtinDir, "task", "fake-task", "SKILL.md"), FAKE_TASK_SKILL);
    // 预置：server 声明（启动预热连接）+ orchestrator 的 mcp-server 启用差异行
    preseedDb(home, { name: "fake", command: process.execPath, args: [serverScript] });

    const seen: Array<{ tools: string[] }> = [];
    let daemon: Daemon | undefined;
    try {
      daemon = await createTestDaemon({
        home,
        engine: new FakeAgentEngine(),
        skipLock: true,
        skipConfig: true,
        port: 0,
        cliInput: new PassThrough(),
        cliOutput: new PassThrough(),
        builtinSkillsDir: builtinDir,
        kgWorkspaceRoot: home, // 隔离真实 kg 项目（密闭性）
        orchestratorLlmOverride: {
          model: () => fakeModel,
          streamFn: makeCapturingStreamFn(seen),
          apiKeys: () => ({ fake: "explicit-key" }),
        },
      });

      // 轮询建任务：每次 kickoff 消费 orchestratorAssembly 现值；server 到
      // running → onStatusChange → refreshAssembly("orchestrator") 后快照
      // 重算，fake__discover（deferred meta 名）进生效集（差异行已预置启用）。
      // 未修复时快照恒为启动值（启动先于预热，必无 fake__ 名）→ 超时即红。
      const t0 = Date.now();
      for (;;) {
        const before = seen.length;
        await daemon.task.createTask({
          type: "fake-task",
          projects: ["demo"],
          params: { projectRoot: "/tmp/demo" },
          createdBy: "page",
        });
        await until(() => seen.length > before, 5000, "编排 kickoff streamFn 捕获");
        if (seen[seen.length - 1]!.tools.includes("fake__discover")) break;
        if (Date.now() - t0 > 25000) {
          throw new Error(
            `25s 内 orchestrator 快照未随 MCP 到位刷新（最近捕获：${seen[seen.length - 1]!.tools.join(",")}）`,
          );
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      // 静态声明面不动（编排工具族仍在）——快照重算只增 MCP 名不丢既有面
      expect(seen[seen.length - 1]!.tools).toContain("task_insert_batch");
    } finally {
      await daemon?.shutdown();
    }
  }, 60000);
});
