import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { CoreToolExecutor } from "../../src/adapters/driven/tools/CoreToolExecutor";
import { SubagentLauncher } from "../../src/adapters/driven/subagent/SubagentLauncher";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { AgentInstance } from "../../src/domain/agent/AgentInstance";
import type { InstanceClosureOutcome } from "../../src/application/services/InstanceRunner";
import type { AgentEngineEvent } from "../../src/application/ports/outbound/AgentEnginePort";
import type { ChildOutboundLine } from "../../src/adapters/driven/subagent/transport/wire";

/**
 * 幽灵工具名复发修复批（防扩散层 + 分发兜底）：
 * - ① resolveTools 别名改写：声明面出现「已废弃名表」成员（版本斜差实证
 *   形态——stale 父进程 spawn 快照 HELIX_TOOLS_JSON 携带改名前旧名）且
 *   注册表存在新名 → 解析为委派别名工具（调用自动改写到新名 + 结果首行
 *   改写注记），不再抛错崩溃（当前 RED：resolveTools throw → 子进程整崩）；
 * - ② resolveToolsResilient（子进程兜底装配面）：不匹配任何已知映射的
 *   未注册名 → 错误占位工具（执行返回「未知工具+可用清单」文本让模型
 *   自纠），绝不抛错——子进程装配零崩溃路径；
 * - ③ spawn 上下文消毒（launcher --task argv 面）+ 端到端：伪造含
 *   sandbox_request 的会话上下文 spawn → 工具调用被改写而非崩溃。
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

/** 提权槽 fake（沙箱 on 装配形态）：ask 恒批准 + 裸执行面假输出。 */
const fakePermissionRequestDeps = () => ({
  ask: { request: async () => "approved" as const },
  sessionId: "s-ghost",
  instanceId: "agent-ghost",
  unsandboxedExec: async (command: string) => ({ stdout: `[outside] ${command}`, stderr: "", exitCode: 0 }),
});

/** 工具结果文本（content 块拼接）。 */
const textOf = (result: { content: { type: string; text?: string }[] }): string =>
  result.content.map((b) => (b.type === "text" ? b.text ?? "" : `(${b.type})`)).join("\n");

const tmpRoots: string[] = [];
const tmpDir = (prefix: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
};
/**
 * 最小任务库（batch 表单表）：ChildMain 收口链读 HELIX_DB_PATH 的
 * batch 表（任务归属解析 + closure done 兑底两处惰性直连）——父进程生产
 * 形态先行建库保证；测试形态手建最小表域（空表零行 = 非任务上下文）。
 */
const minimalLedgerDb = (dir: string): string => {
  const dbPath = path.join(dir, "helix.db");
  const db = new Database(dbPath);
  db.exec(
    "CREATE TABLE IF NOT EXISTS batch (" +
      "id TEXT PRIMARY KEY, job_id TEXT NOT NULL, stage_seq INTEGER NOT NULL, seq INTEGER NOT NULL," +
      "scope TEXT NOT NULL, status TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0, retry_note TEXT," +
      "instance_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_batch_instance ON batch(instance_id)");
  db.close();
  return dbPath;
};
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

// ── ① resolveTools 别名改写（已废弃名 → 新名委派） ──────────

describe("已废弃工具名：resolveTools 别名改写（防版本斜差崩溃）", () => {
  test("① 注册表有新名：sandbox_request → 委派 permission_request，结果首行带改写注记（不抛错）", async () => {
    const executor = new CoreToolExecutor({
      cwd: tmpdir(),
      permissionRequest: fakePermissionRequestDeps(),
    });
    // 当前 RED：resolveTools(["sandbox_request"]) 抛「不在注册表」
    const resolved = executor.resolveTools(["sandbox_request"]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.name).toBe("sandbox_request"); // 别名保留声明名（provider 工具清单与声明面一致）
    const result = await resolved[0]!.execute("call-1", { command: "echo hi", reason: "测试" }, undefined, () => {});
    expect(result).toBeDefined();
    const text = textOf(result as unknown as { content: { type: string; text?: string }[] });
    expect(text).toContain("已自动改写：sandbox_request → permission_request");
    expect(text).toContain("[outside] echo hi"); // 真实委派到新工具执行（非占位）
  });

  test("② 注册表无新名（沙箱 off 形态）：映射不可用 → 维持既有未注册语义（resolveTools 抛错）", () => {
    const executor = new CoreToolExecutor({ cwd: tmpdir() }); // 无 permissionRequest 槽
    expect(() => executor.resolveTools(["sandbox_request"])).toThrow(/不在注册表/);
  });

  test("③ 真名直连不受别名分支影响：permission_request 本名照常解析", () => {
    const executor = new CoreToolExecutor({
      cwd: tmpdir(),
      permissionRequest: fakePermissionRequestDeps(),
    });
    const resolved = executor.resolveTools(["permission_request"]);
    expect(resolved.map((t) => t.name)).toEqual(["permission_request"]);
  });
});

// ── ② resolveToolsResilient（子进程兜底装配面——绝不崩溃） ──

describe("resolveToolsResilient：未注册名 → 错误占位工具（模型自纠），零抛错", () => {
  test("① 未知名（无映射）：返回占位工具而非抛错；执行返回「未知工具+可用清单」", async () => {
    const executor = new CoreToolExecutor({ cwd: tmpdir() });
    let resolved: AgentTool<any>[] = [];
    expect(() => {
      resolved = executor.resolveToolsResilient(["ghost_tool"]);
    }).not.toThrow();
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.name).toBe("ghost_tool");
    const result = await resolved[0]!.execute("call-2", {}, undefined, () => {});
    const text = textOf(result as unknown as { content: { type: string; text?: string }[] });
    expect(text).toContain('未知工具 "ghost_tool"');
    expect(text).toContain("可用"); // 含可用工具清单（bash 等基线恒注册）
    expect(text).toContain("bash");
  });

  test("② 废弃名 + 无新名（映射目标缺席）：同样走占位兜底不崩溃", async () => {
    const executor = new CoreToolExecutor({ cwd: tmpdir() }); // 沙箱 off：permission_request 未注册
    const resolved = executor.resolveToolsResilient(["sandbox_request"]);
    expect(resolved).toHaveLength(1);
    const result = await resolved[0]!.execute("call-3", {}, undefined, () => {});
    const text = textOf(result as unknown as { content: { type: string; text?: string }[] });
    expect(text).toContain("sandbox_request");
  });

  test("③ 混合清单：真名真解析 + 幽灵名占位（长度一致，真名可执行）", async () => {
    const executor = new CoreToolExecutor({ cwd: tmpdir() });
    const resolved = executor.resolveToolsResilient(["bash", "ghost_tool", "read"]);
    expect(resolved.map((t) => t.name)).toEqual(["bash", "ghost_tool", "read"]);
    expect(resolved[0]!.name).toBe("bash"); // 真名走正常解析路径
  });
});

// ── ③ spawn 上下文消毒（--task argv 面）+ 端到端 ──────────────

interface SpawnCall {
  readonly cmd: readonly string[];
  readonly env: Record<string, string | undefined>;
}

function patchSpawn(capture: SpawnCall[]): void {
  const fakeProc = () =>
    ({
      pid: 42000 + Math.floor(Math.random() * 900),
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

describe("launcher spawn 消毒：task 文本（会话内容载体）先消毒再进 --task argv", () => {
  test("brief 含 sandbox_request → argv 内已改写为新名+注记（裸旧名清零）", () => {
    const real = Bun.spawn;
    const calls: SpawnCall[] = [];
    patchSpawn(calls);
    try {
      const launcher = new SubagentLauncher({
        profile: SubAgentProfile,
        model: fakeModel,
        apiKeys: {},
        toolCwd: tmpdir(),
      });
      launcher.launch(
        AgentInstance.create({
          instanceId: "agent-sanitize",
          kind: "subagent",
          profileKind: "subagent-worker",
          sessionId: "s-sanitize",
          createdAt: "2026-09-20T00:00:00.000Z",
        }),
        "参考历史：之前用 sandbox_request 提权；本任务继续该方案。",
      );
      const taskArg = calls[0]!.cmd[calls[0]!.cmd.indexOf("--task") + 1]!;
      expect(taskArg).toContain("permission_request（沙箱外执行申请通道");
      expect(taskArg).toContain("旧名 sandbox_request 已废弃");
      expect(taskArg.replace(/旧名 sandbox_request 已废弃/g, "")).not.toContain("sandbox_request");
    } finally {
      (Bun as unknown as { spawn: unknown }).spawn = real;
    }
  });
});

describe("端到端：幽灵名快照 spawn（版本斜差形态复现）——调用被改写而非崩溃", () => {
  test(
    "spawn 快照 tools 含 sandbox_request + 剧本调用该名 → 别名改写执行 + closure done（非 crash）",
    async () => {
      const home = tmpDir("helix-ghost-tool-");
      const scriptPath = path.join(home, "script.json");
      // 剧本：首 turn 调幽灵名（模型照搬上下文旧名的复现），次 turn closure
      writeFileSync(
        scriptPath,
        JSON.stringify({
          replies: [closureBlock("ghost-rewrite-done")],
          toolCalls: [{ name: "sandbox_request", args: { command: "echo ghost", reason: "端到端" } }],
        }),
      );
      const closures: { instanceId: string; outcome: InstanceClosureOutcome }[] = [];
      const toolEnds: { toolName: string; text: string }[] = [];
      const launcher = new SubagentLauncher({
        profile: SubAgentProfile,
        model: fakeModel,
        apiKeys: { fake: "explicit-key" },
        toolCwd: home,
        fakeEngineScript: scriptPath,
        // 版本斜差复现：stale 父进程快照携带改名前旧名（sandbox_request）
        spawnSnapshot: () => ({
          tools: [...SubAgentProfile.tools, "sandbox_request"],
          systemPrompt: "SUB base + 工具清单",
        }),
        // 沙箱 on（permission_request 注册前提——HELIX_SANDBOX=1 + HELIX_DB_PATH；
        // db 为最小 batch 表域：收口链惰性直连零行返回非任务上下文）
        sandboxConfig: { current: () => ({ enabled: true, extraRoots: [] }) },
        ledgerDbPath: minimalLedgerDb(home),
        onLine: (_id, line: ChildOutboundLine) => {
          if (line.type === "event") {
            const ev = line.event as AgentEngineEvent;
            if (ev.type === "tool_execution_end") {
              toolEnds.push({ toolName: ev.toolName, text: ev.result });
            }
          }
        },
      });
      launcher.setCallbacks({
        onInstanceEvent: () => {},
        onInstanceClosure: (instanceId, outcome) => closures.push({ instanceId, outcome }),
      });

      launcher.launch(
        AgentInstance.create({
          instanceId: "agent-ghost-e2e",
          kind: "subagent",
          profileKind: "subagent-worker",
          sessionId: "s-ghost-e2e",
          createdAt: "2026-09-20T00:00:00.000Z",
        }),
        "任务文本（含 sandbox_request 历史引用，消毒层应改写）",
      );
      await new Promise<void>((resolve, reject) => {
        const t0 = Date.now();
        const timer = setInterval(() => {
          if (closures.length > 0) {
            clearInterval(timer);
            resolve();
          } else if (Date.now() - t0 > 30000) {
            clearInterval(timer);
            reject(new Error("等待 closure 超时"));
          }
        }, 20);
      });

      // 核心断言：不崩（closure done 而非 crash failed）+ 调用被改写（注记行）
      expect(closures[0]!.outcome.result).toBe("done");
      const ghostCall = toolEnds.find((t) => t.toolName === "sandbox_request");
      expect(ghostCall).toBeDefined();
      expect(ghostCall!.text).toContain("已自动改写：sandbox_request → permission_request");
    },
    45000,
  );

  // 「沙箱 off + 幽灵名」的占位兜底形态不在 e2e 面复现：测试运行环境可能
  // 自身携带 HELIX_SANDBOX=1（helix SubAgent 沙箱内跑测），launcher 展开
  // 继承 process.env、测试面无法剥除该键——off 形态由上方 resolveToolsResilient
  // 单测②面覆盖（executor 无 permissionRequest 槽 → 幽灵名走占位兜底）。
});
