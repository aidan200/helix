import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { SubagentLauncher } from "../../src/adapters/driven/subagent/SubagentLauncher";
import { buildLocalWorkLedgerStack } from "../../src/adapters/driven/subagent/child/ChildMain";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { MainSessionProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import { SchedulingPolicy } from "../../src/domain/agent/SchedulingPolicy";
import { SchedulerService } from "../../src/application/services/scheduler/SchedulerService";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { SqliteSessionRepository } from "../../src/adapters/driven/sqlite-session/SqliteSessionRepository";
import { parentWorkLedger } from "../../src/adapters/driven/sqlite-session/WorkLedger";
import { WorkLedgerService } from "../../src/application/services/task/WorkLedgerService";
import { CoreToolExecutor } from "../../src/adapters/driven/tools/CoreToolExecutor";
import type { EventPublisherPort } from "../../src/application/ports/outbound/EventPublisherPort";
import type { ClockPort } from "../../src/application/ports/outbound/ClockPort";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import { AgentInstance } from "../../src/domain/agent/AgentInstance";

/**
 * I 层：plan 工具族两域统一性（T1.4，CL-2-T7，AD-6①）。
 *
 * 「chat/task 两域派出的 SubAgent 写口逐字节一致」机械断言：
 * ① 装配面——chat 域 fixture 与 task 域 fixture 各自走子进程组合根工厂
 *   （buildLocalWorkLedgerStack，唯一装配面）+ resolveTools(SubAgentProfile.tools)，
 *   断言两 fixture 的工具名集与参数 schema JSON 相等，且 plan 三名在集；
 * ② 配给面——SubAgentProfile 与 MainSessionProfile 工具声明同含 plan 三名
 *   （main-session plan 批：两域同构——子进程 instanceId = agent-N、主会话
 *   instanceId = sessionId）；工具面零派发方语义词（SubAgent 不感知谁派发）；
 * ③ 子进程级——chat 域经 SchedulerService.spawn（chat MainAgent 既有派发路）、
 *   task 域经 launcher.launch（编排器将走的同一 InstanceRunner 面）各拉一个
 *   真子进程（fake 剧本 toolCall plan_create），断言两实例行落同一 work_item
 *   表（同表同方法），父进程 getPlan 各读到各的。
 */

const SESSION_ID = "s-plan-uniform";
const FIXED_NOW = "2026-08-29T00:00:00.000Z";
const TASK_INSTANCE_ID = "batch-inst-task-fx";

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

const PLAN_TOOL_NAMES = ["plan_create", "plan_update", "plan_read"] as const;

/** 装配面签名：名集 + 逐名 schema JSON（逐字节一致断言的载荷）。 */
function assemblySignature(dbPath: string, instanceId: string): { names: string[]; schemas: Record<string, string> } {
  const stack = buildLocalWorkLedgerStack(dbPath, instanceId);
  const executor = new CoreToolExecutor({ cwd: path.dirname(dbPath), plan: stack.tools });
  // 只解析 plan 三名（完整 SubAgentProfile.tools 解析需 browser/kg 注入面——
  // 子进程真装配的完整集解析由 ③ 子进程级测试证明，此处断言两域 plan 写口面）
  const resolved = executor.resolveTools([...PLAN_TOOL_NAMES]);
  const schemas: Record<string, string> = {};
  for (const tool of resolved) {
    schemas[tool.name] = JSON.stringify((tool as { parameters?: unknown }).parameters ?? null);
  }
  stack.ledger.close();
  return { names: resolved.map((t) => t.name), schemas };
}

describe("① 装配统一：两域 fixture 的工具名集与 schema 逐字节相等（AD-6①）", () => {
  test("chat 域 fixture 与 task 域 fixture 名集相等 + 逐名 schema JSON 相等 + plan 三名在集", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "helix-plan-asm-"));
    const dbPath = path.join(dir, "helix.db");
    const queue = new WriteQueue(dbPath); // 父连接建表域（生产时序）
    try {
      // chat 域 fixture：chat MainAgent spawn 的实例（agent-<串> 命名面）
      const chat = assemblySignature(dbPath, "agent-chat-fx");
      // task 域 fixture：编排器派出的批次实例（batch.instance_id 命名面）
      const task = assemblySignature(dbPath, TASK_INSTANCE_ID);

      expect(chat.names).toEqual(task.names); // 工具名集相等
      expect(chat.schemas).toEqual(task.schemas); // 参数 schema 逐字节相等
      for (const name of PLAN_TOOL_NAMES) {
        expect(chat.names).toContain(name); // plan 三名在集
        expect(chat.schemas[name]).toBeDefined();
      }
      expect(chat.names).toEqual([...PLAN_TOOL_NAMES]);
    } finally {
      queue.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("② 配给面：plan 三工具两域同构配给（SubAgent 子进程 + 主会话，main-session plan 批）", () => {
  test("SubAgentProfile 与 MainSessionProfile 声明同含 plan 三名（两域同构，AD-6① 扩展到主会话）", () => {
    for (const name of PLAN_TOOL_NAMES) {
      expect(SubAgentProfile.tools).toContain(name);
      expect(MainSessionProfile.tools).toContain(name);
    }
  });

  test("工具描述与参数 schema 零派发方语义词（SubAgent 不感知谁派发）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "helix-plan-vocab-"));
    const dbPath = path.join(dir, "helix.db");
    const queue = new WriteQueue(dbPath);
    try {
      const stack = buildLocalWorkLedgerStack(dbPath, "agent-vocab");
      const executor = new CoreToolExecutor({ cwd: dir, plan: stack.tools });
      const planTools = executor.resolveTools([...PLAN_TOOL_NAMES]);
      for (const tool of planTools) {
        const face = JSON.stringify({
          name: tool.name,
          description: (tool as { description?: string }).description,
          parameters: (tool as { parameters?: unknown }).parameters,
        });
        // 派发方语义词零命中（不感知 chat/task 派发）
        for (const word of ["任务", "批次", "编排", "chat", "task", "batch", "orchestr"]) {
          expect(face.includes(word), `${tool.name} 工具面含派发方语义词「${word}」`).toBe(false);
        }
      }
      stack.ledger.close();
    } finally {
      queue.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── ③ 子进程级：两域派发路各拉真子进程，plan_create 落同一表 ──────

interface Harness {
  readonly launcher: SubagentLauncher;
  readonly scheduler: SchedulerService;
  readonly writeQueue: WriteQueue;
  readonly home: string;
  readonly events: DomainEvent[];
  readonly closures: string[]; // closure 行观测（launcher onLine 面，两域共用）
  readonly toolEnds: { toolName: string; isError: boolean }[];
}

function makeHarness(): Harness {
  const home = mkdtempSync(path.join(tmpdir(), "helix-plan-child-"));
  const dbPath = path.join(home, "helix.db");
  const scriptPath = path.join(home, "script.json");
  writeFileSync(
    scriptPath,
    JSON.stringify({
      toolCall: { name: "plan_create", args: { items: ["探索输入", "落账产出", "自查收口"] } },
      replies: [
        "台账已建并推进。" +
          "<<<CLOSURE\n" +
          JSON.stringify({ status: "done", summary: "台账建立完成", reportPath: null, findings: [], taskId: null }) +
          "\nCLOSURE>>>",
      ],
      chunkDelayMs: 5,
    }),
  );
  const writeQueue = new WriteQueue(dbPath);
  const repository = new SqliteSessionRepository(writeQueue);
  const events: DomainEvent[] = [];
  const publisher: EventPublisherPort = { publish: (e) => events.push(e), publishDelta: () => undefined };
  const clock: ClockPort = { now: () => FIXED_NOW, nowMs: () => Date.parse(FIXED_NOW) };
  const closures: string[] = [];
  const toolEnds: { toolName: string; isError: boolean }[] = [];
  const launcher = new SubagentLauncher({
    profile: SubAgentProfile,
    model: fakeModel,
    apiKeys: { fake: "k" },
    toolCwd: home,
    fakeEngineScript: scriptPath,
    // T1.4：台账库路径 env 注入（生产 = 组合根 paths.dbPath()；测试 = tmp 库）
    ledgerDbPath: dbPath,
    onLine: (instanceId, line) => {
      if (line.type === "closure") closures.push(instanceId);
      if (line.type === "event" && line.event.type === "tool_execution_end") {
        toolEnds.push({ toolName: line.event.toolName, isError: line.event.isError });
      }
    },
  });
  const scheduler = new SchedulerService({
    policy: new SchedulingPolicy(),
    runner: launcher,
    events: publisher,
    repository,
    clock,
    stalledPollMs: 100,
  });
  return { launcher, scheduler, writeQueue, home, events, closures, toolEnds };
}

function until(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (cond()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`until 超时：${label}（${timeoutMs}ms）`));
      }
    }, 5);
  });
}

let current: Harness | undefined;
afterEach(async () => {
  if (current) {
    current.scheduler.stop();
    await current.launcher.dispose();
    await current.writeQueue.close();
    rmSync(current.home, { recursive: true, force: true });
    current = undefined;
  }
});

describe("③ 子进程级：两域派发路 → plan_create 落同一 work_item 表（CL-2-T7）", () => {
  test("chat 域（SchedulerService.spawn）与 task 域（launcher.launch）各自 plan_create 成功落同一表", async () => {
    const h = (current = makeHarness());
    // chat 域派发路：chat MainAgent 经编排工具族 → SchedulerService.spawn
    const chatSpawn = h.scheduler.spawn(SESSION_ID, "chat 域实例：建台账");
    expect(chatSpawn.status).toBe("run");
    if (chatSpawn.status !== "run") throw new Error("unreachable");
    const chatId = chatSpawn.agentId;
    // task 域派发路：编排器将走的同一 InstanceRunner 面（launcher.launch 直面）
    h.launcher.launch(
      AgentInstance.create({
        instanceId: TASK_INSTANCE_ID,
        kind: "subagent",
        profileKind: "subagent-worker",
        sessionId: SESSION_ID,
        createdAt: FIXED_NOW,
      }),
      "task 域实例：建台账",
    );

    // 两子进程均收口（closure 行经 launcher onLine 面——两域共用同一观测位）
    await until(() => h.closures.length >= 2, 25000, "等待两子进程 closure 行");

    // 两实例 plan_create 工具调用均成功（子进程真装配可用）
    const planCreates = h.toolEnds.filter((t) => t.toolName === "plan_create");
    expect(planCreates.length).toBe(2);
    expect(planCreates.every((t) => !t.isError)).toBe(true);

    // 同表同方法：两域实例行落同一 work_item 表，父进程读口各读到各的
    const parent = new WorkLedgerService({ reader: parentWorkLedger(h.writeQueue) });
    const chatRows = parent.getPlan(chatId);
    const taskRows = parent.getPlan(TASK_INSTANCE_ID);
    expect(chatRows.map((r) => [r.seq, r.status])).toEqual([
      [1, "pending"],
      [2, "pending"],
      [3, "pending"],
    ]);
    expect(taskRows.map((r) => [r.seq, r.status])).toEqual([
      [1, "pending"],
      [2, "pending"],
      [3, "pending"],
    ]);
    // chat 域实例经调度侧正常收口（agent.completed 域事件）
    await until(() => h.events.some((e) => e.type === "agent.completed"), 5000, "等待 agent.completed");
  }, 40000);
});
