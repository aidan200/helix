import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Api, AssistantMessage, Context, Model, Models } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { TaskStore } from "../../src/adapters/driven/sqlite-session/TaskStore";
import { parentWorkLedger } from "../../src/adapters/driven/sqlite-session/WorkLedger";
import { TaskEngineService } from "../../src/application/services/task/TaskEngineService";
import { WorkLedgerService } from "../../src/application/services/task/WorkLedgerService";
import { TaskOrchestratorService } from "../../src/application/services/task/TaskOrchestratorService";
import type { OrchestratorSessionFace } from "../../src/application/services/task/TaskOrchestratorService";
import { FakeTaskSkillRegistry, counterClock, childLedger } from "./task-fixtures";
import { CoreToolExecutor } from "../../src/adapters/driven/tools/CoreToolExecutor";
import { PiAgentEngineAdapter } from "../../src/adapters/driven/pi-engine/PiAgentEngineAdapter";
import { OrchestratorProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/OrchestratorProfile";
import { PLAN_HARD_CONSTRAINT_SEGMENT } from "../../src/adapters/driven/pi-engine/runtime/templates/catalog";
import type { SpawnOutcome, AgentOrchestrationPort } from "../../src/application/ports/inbound/AgentOrchestrationPort";
import type { TaskEnginePort } from "../../src/application/ports/inbound/TaskEnginePort";
import type { WorkLedger } from "../../src/adapters/driven/sqlite-session/WorkLedger";
import type { TaskManifest } from "../../src/domain/task/types";

/**
 * 编排主 agent 运行时集成测基建（T2.2，TR-TEST-4 真 SQLite @ tmp）：
 * - 编排会话 = 真 pi 运行时（PiAgentEngineAdapter + OrchestratorProfile +
 *   真 CoreToolExecutor）+ 剧本化 streamFn（tools-loop.test.ts 同构：LLM
 *   「发起」是剧本，「执行」与「回注」是真的——task 引擎回口工具真落库）；
 * - fake spawn 记录器（默认形态）：记录 brief + spawn 时刻 batch 行存在性；
 * - 预算形态：注入真 SchedulerService + fake runner（在跑数断言）。
 */

// ── 剧本化 LLM（tools-loop.test.ts makeToolScriptedLLM 同构 + 结果插值） ──

export type ScriptEntry =
  | {
      kind: "tool";
      toolName: string;
      args?: Record<string, unknown>;
      /** 需要引用先前工具结果时用 build（入参 = 截至本 turn 的全部工具结果文本，按到达序）。 */
      build?: (results: readonly string[]) => { toolName: string; args: Record<string, unknown> };
    }
  | { kind: "reply"; text?: string };

/** 便捷构造：task_insert_batch 条目。 */
export const insertBatchEntry = (stageSeq: number, scope: string): ScriptEntry => ({
  kind: "tool",
  toolName: "task_insert_batch",
  args: { stageSeq, scope },
});

/** 便捷构造：agent_spawn 条目。 */
export const spawnEntry = (brief: string): ScriptEntry => ({ kind: "tool", toolName: "agent_spawn", args: { task: brief } });

/** 便捷构造：task_dispatch_batch 条目（batchId 取第 idx 条工具结果，instanceId 取第 idy 条）。 */
export const dispatchEntry = (batchResultIdx: number, agentResultIdx: number): ScriptEntry => ({
  kind: "tool",
  toolName: "task_dispatch_batch",
  build: (results) => {
    const batchId = (JSON.parse(results[batchResultIdx]!) as { batchId: string }).batchId;
    const instanceId = (JSON.parse(results[agentResultIdx]!) as { agentId: string }).agentId;
    return { toolName: "task_dispatch_batch", args: { batchId, instanceId } };
  },
});

const fakeModel = {
  id: "model",
  name: "Fake Model",
  api: "anthropic-messages" as Api,
  provider: "fake",
  baseUrl: "http://localhost-unused",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8192,
} as unknown as Model<any>;

const fakeModels = {
  getModel: (provider: string, id: string) => (provider === "fake" && id === "model" ? fakeModel : undefined),
  getModels: (provider: string) => (provider === "fake" ? [fakeModel] : []),
  streamSimple: () => {
    throw new Error("不应走到真实流（streamFnOverride 未生效）");
  },
} as unknown as Models;

function baseAssistant(content: AssistantMessage["content"], stopReason: string): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "fake",
    model: "model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: stopReason as AssistantMessage["stopReason"],
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

function toolResultTexts(context: Context): string[] {
  return context.messages
    .filter((m) => m.role === "toolResult")
    .map((m) => m.content.map((c) => (c.type === "text" ? c.text : "")).join(""));
}

/** 剧本化 streamFn：tool 条目→发起调用（可按先前真实结果插值）；reply 条目→收口文本。 */
export function makeScriptedLLM(entries: ScriptEntry[]): StreamFn {
  const queue = [...entries];
  let seq = 0;
  return (_model, context, _options) => {
    const entry = queue.shift() ?? { kind: "reply" as const, text: "（剧本耗尽，等待收口注入）" };
    const spec =
      entry.kind === "tool"
        ? entry.build !== undefined
          ? entry.build(toolResultTexts(context as Context))
          : { toolName: entry.toolName, args: entry.args ?? {} }
        : null;
    const replyText = entry.kind === "reply" ? (entry as { text?: string }).text : undefined;
    const message =
      spec !== null
        ? baseAssistant([{ type: "toolCall", id: `call-${++seq}`, name: spec.toolName, arguments: spec.args }], "toolUse")
        : baseAssistant([{ type: "text", text: replyText ?? "（编排收口等待中）" }], "stop");
    const stream = createAssistantMessageEventStream();
    void (async () => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
    })();
    return stream;
  };
}

// ── fake spawn 记录器（默认形态） ──────────────────────────

export interface RecordedSpawn {
  readonly agentId: string;
  readonly sessionId: string;
  readonly brief: string;
  readonly timestamp: number;
  /** spawn 调用时刻该 job 已落库的 batch 行数（断言「行先于 spawn」）。 */
  readonly batchRowCountAtSpawn: number;
}

export class FakeSpawnRecorder {
  readonly calls: RecordedSpawn[] = [];
  /** 测试预置的实例终态（agentId → closure 态 + 摘要）。 */
  readonly outcomes = new Map<string, { state: string; summary?: string }>();
  private next = 0;

  constructor(private readonly batchRowCountOf: (jobId: string) => number) {}

  spawn(sessionId: string, brief: string): SpawnOutcome {
    const jobId = sessionId.startsWith("task:") ? sessionId.slice("task:".length) : sessionId;
    this.calls.push({
      agentId: `agent-test-${++this.next}`,
      sessionId,
      brief,
      timestamp: Date.now(),
      batchRowCountAtSpawn: this.batchRowCountOf(jobId),
    });
    return { status: "run", agentId: this.calls[this.calls.length - 1]!.agentId };
  }

  /** 第 n 次（1 起）spawn 的记录。 */
  call(n: number): RecordedSpawn {
    const hit = this.calls[n - 1];
    if (hit === undefined) throw new Error(`第 ${n} 次 spawn 尚未发生`);
    return hit;
  }
}

// ── 环境装配 ──────────────────────────────────────────────

/** 单阶段 manifest（批次循环主链测试用；plan=enforced 走硬约束追加面）。 */
export function singleStageManifest(plan: "enforced" | "optional" = "enforced"): TaskManifest {
  return {
    paramsSchema: { projectRoot: { type: "string", required: true } },
    stages: { strategy: "fixed", list: ["L0 核心层"] },
    confirm: "skip",
    plan,
    projects: { min: 1, max: 1 },
  };
}

export const FAKE_SKILL_BODY = [
  "# fake-task 任务 SOP（测试注入的 skill 全文）",
  "",
  "## ② 批次划分原则",
  "按模块实况切批，单批工作量有界；层内批次可并行。",
  "",
  "## ③ 批次 brief 装配模板",
  "范围段 + 锚定上层上下文段 + 产出要求段 + 验收段。",
  "",
  "## ⑤ 完成判定",
  "各层产出齐 + 各批 closure resolve + 阶段产物聚合完成。",
].join("\n");

export interface OrchestratorEnvOverrides {
  /** 编排 LLM 剧本（跨 drive 共享队列）。 */
  readonly script: readonly ScriptEntry[];
  /** spawn 面覆盖（预算测试注入真调度器绑定形态）。 */
  readonly rawSpawn?: (sessionId: string, task: string, profileKind?: string) => SpawnOutcome;
  /** 实例终态读面覆盖（预算测试注入 scheduler.status）。 */
  readonly instanceOutcome?: (agentId: string) => { state: string; summary?: string } | undefined;
  /** manifest plan 档位（缺省 enforced）。 */
  readonly plan?: "enforced" | "optional";
  /** W2-D：job 终态提示面（onJobTerminal 断言采集）。 */
  readonly onJobTerminal?: (jobId: string, status: string) => void;
  /** 额外注册的任务类型（W-R6 分流测试：kg-bootstrap/kg-review 同形 manifest）。 */
  readonly extraTypes?: readonly string[];
  /** 链 A（⑤）：批次实例挂起原语覆盖（缺省 = 即时挂起成立的 fake）。 */
  readonly parkInstance?: (agentId: string, reason: "user" | "taskPause") => { parked: boolean; error?: string };
  /** 链 A（⑤）：批次实例复活原语覆盖（缺省 = 即时复活成立的 fake）。 */
  readonly resumeInstance?: (agentId: string) => { resumed: boolean; queued?: boolean; error?: string };
  /** 卡装配修复面：前 N 次 drive 抛错（模拟首轮驱动异常——重试唤醒链断言注入）。 */
  readonly failFirstDrives?: number;
}

export interface OrchestratorEnv {
  readonly engine: TaskEnginePort;
  readonly store: TaskStore;
  readonly orchestrator: TaskOrchestratorService;
  readonly recorder: FakeSpawnRecorder;
  readonly dbPath: string;
  /** 编排会话驱动日志（drive/inject 观测——挂起期「不驱动回合」断言依据，链 A）。 */
  readonly sessionLog: { kind: "drive" | "inject"; text: string }[];
  /** 编排服务日志捕获（info/warn 平铺——驱动可观测性与重试链断言面）。 */
  readonly orchestratorLog: string[];
  /** 子进程形态台账直写面（模拟批次实例 plan 落账）。 */
  childLedger(): WorkLedger;
  /** 条件等待（编排链路异步收口确定性锚）。 */
  until(cond: () => boolean, ms?: number): Promise<void>;
  dispose(): Promise<void>;
}

export async function withOrchestratorEnv(
  over: OrchestratorEnvOverrides,
  fn: (env: OrchestratorEnv) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-orch-"));
  const dbPath = path.join(dir, "helix.db");
  const queue = new WriteQueue(dbPath);
  const store = new TaskStore(queue);
  const workLedgerParent = parentWorkLedger(queue);
  const ledger = new WorkLedgerService({ reader: workLedgerParent });
  const skills = new FakeTaskSkillRegistry();
  skills.register("fake-task", singleStageManifest(over.plan ?? "enforced"), "测试任务类型");
  for (const type of over.extraTypes ?? []) {
    skills.register(type, singleStageManifest(over.plan ?? "enforced"), `${type}（测试注册）`);
  }
  const clock = counterClock();

  // 编排服务经 starter 代理后填（引擎 ↔ 编排环）
  let orchestratorRef: TaskOrchestratorService | undefined;
  const starterProxy = {
    async startOrchestrator(jobId: string): Promise<void> {
      await orchestratorRef?.startOrchestrator(jobId);
    },
    async stopOrchestrator(jobId: string): Promise<void> {
      await orchestratorRef?.stopOrchestrator(jobId);
    },
    async parkAll(jobId: string): Promise<void> {
      await orchestratorRef?.parkAll(jobId);
    },
    async resumeAll(jobId: string): Promise<void> {
      await orchestratorRef?.resumeAll(jobId);
    },
  };
  const engine = new TaskEngineService({
    store,
    skills,
    starter: starterProxy,
    workLedger: workLedgerParent,
    clock,
  });

  const recorder = new FakeSpawnRecorder((jobId) =>
    store.getStages(jobId).reduce((n, s) => n + store.getBatches(jobId, s.seq).length, 0),
  );
  const scriptedStream = makeScriptedLLM([...over.script]);
  const sessionLog: { kind: "drive" | "inject"; text: string }[] = [];
  const orchestratorLog: string[] = [];
  let driveFailuresLeft = over.failFirstDrives ?? 0;
  const createSession = (jobId: string, orchestration: AgentOrchestrationPort): OrchestratorSessionFace => {
    const executor = new CoreToolExecutor({
      cwd: dir,
      orchestration,
      kg: {
        query: { search: () => [], get: () => null, locate: () => [], affected: () => [] },
        workspaceRoot: dir,
        scanProjects: () => [],
      },
      taskOps: {
        jobId,
        taskEngine: engine,
        ledger,
      },
    });
    const adapter = new PiAgentEngineAdapter({
      profile: OrchestratorProfile,
      model: fakeModel,
      apiKeys: { fake: "explicit-key" },
      models: fakeModels,
      streamFnOverride: scriptedStream,
      resolveTools: (names) => executor.resolveTools(names),
    });
    return {
      drive: async (prompt) => {
        sessionLog.push({ kind: "drive", text: prompt });
        if (driveFailuresLeft > 0) {
          driveFailuresLeft -= 1;
          throw new Error(`scripted drive failure（剩余注入 ${driveFailuresLeft} 次）`);
        }
        await adapter.start(prompt, () => undefined);
      },
      inject: (text) => {
        sessionLog.push({ kind: "inject", text });
        adapter.steer(text);
      },
      abort: () => adapter.abort(),
    };
  };

  const orchestrator = new TaskOrchestratorService({
    store,
    taskEngine: engine,
    ledger,
    skills,
    skillTextOf: async (type) => (type === "fake-task" ? FAKE_SKILL_BODY : undefined),
    rawSpawn: over.rawSpawn ?? ((sessionId, task) => recorder.spawn(sessionId, task)),
    instanceOutcome:
      over.instanceOutcome ?? ((agentId) => recorder.outcomes.get(agentId) ?? { state: "running" }),
    killInstance: () => undefined,
    // 链 A（⑤）：缺省 fake（即时成立）；真调度器级测链归 task-park-resume.test
    parkInstance: over.parkInstance ?? (() => ({ parked: true })),
    resumeInstance: over.resumeInstance ?? (() => ({ resumed: true, queued: false })),
    createSession,
    planHardConstraint: PLAN_HARD_CONSTRAINT_SEGMENT,
    logger: {
      info: (m: string) => orchestratorLog.push(`[INFO] ${m}`),
      warn: (m: string) => orchestratorLog.push(`[WARN] ${m}`),
    },
    ...(over.onJobTerminal !== undefined ? { onJobTerminal: over.onJobTerminal } : {}),
  });
  orchestratorRef = orchestrator;

  const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > ms) throw new Error("编排链路条件等待超时");
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  try {
    await fn({ engine, store, orchestrator, recorder, dbPath, sessionLog, orchestratorLog, childLedger: () => childLedger(dbPath), until, dispose: async () => {
      await queue.close();
      rmSync(dir, { recursive: true, force: true });
    } });
  } finally {
    await queue.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 模拟批次实例收口：预置 plan 行（可选）+ 终态登记 + 触发编排收口路径。 */
export async function settleInstance(
  env: OrchestratorEnv,
  agentId: string,
  opts: {
    closure: "done" | "failed";
    plan?: "resolved" | "unresolved" | "none";
    summary?: string;
  },
): Promise<void> {
  const ledger = env.childLedger();
  if (opts.plan === "resolved") {
    await ledger.insertItems(agentId, [
      { seq: 1, content: "探索 A 模块结构" },
      { seq: 2, content: "产出架构节点" },
    ]);
    await ledger.updateItem(agentId, 1, "done", "产物指针：node-L0-1（confirmed）");
    await ledger.updateItem(agentId, 2, "done", "产物指针：node-L0-2（confirmed）");
  } else if (opts.plan === "unresolved") {
    await ledger.insertItems(agentId, [
      { seq: 1, content: "探索 A 模块结构" },
      { seq: 2, content: "产出架构节点（未完成）" },
    ]);
    await ledger.updateItem(agentId, 1, "done", "产物指针：node-L0-1（confirmed）");
  }
  env.recorder.outcomes.set(agentId, {
    state: opts.closure === "done" ? "done" : "failed",
    summary: opts.summary ?? (opts.closure === "done" ? "批次完成" : "批次执行中断"),
  });
  env.orchestrator.handleInstanceClosure(agentId);
}
