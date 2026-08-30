import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WriteQueue, openTaskLedgerDatabase } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { TaskStore } from "../../src/adapters/driven/sqlite-session/TaskStore";
import { WorkLedger, parentWorkLedger, type WorkLedgerParentFace } from "../../src/adapters/driven/sqlite-session/WorkLedger";
import { TaskEngineService } from "../../src/application/services/task/TaskEngineService";
import { TaskQueryService } from "../../src/application/services/task/TaskQueryService";
import type {
  TaskSkillRegistryPort,
  TaskTypeInfo,
} from "../../src/application/ports/outbound/TaskSkillRegistryPort";
import type { TaskOrchestratorStarterPort } from "../../src/application/ports/outbound/TaskOrchestratorStarterPort";
import type { ClockPort } from "../../src/application/ports/outbound/ClockPort";
import type { TaskManifest } from "../../src/domain/task/types";

/**
 * 任务引擎/查询服务集成测共用基建（TR-TEST-4：真 SQLite @ tmp，不碰 ~/.helix）：
 * - FakeTaskSkillRegistry / FakeOrchestratorStarter = brief 指定的内存 fake
 *   （T2.3/T2.2 提供真实现）；
 * - counterClock = 确定性时间源（每次调用 +1s，createdAt 断言可钉）。
 */

/** kg-bootstrap 同形 manifest（fixed 三阶段，projects 恰 1 个，§7.1）。 */
export function kgBootstrapManifest(): TaskManifest {
  return {
    paramsSchema: {
      projectRoot: { type: "string", required: true },
      scope: { type: "string" },
    },
    stages: { strategy: "fixed", list: ["L0 核心层", "L1 领域层", "L2 实体层"] },
    confirm: "required",
    plan: "enforced",
    projects: { min: 1, max: 1 },
  };
}

/** 0..n 项目类型 manifest（AD-8：projects 空数组合法）。 */
export function zeroProjectManifest(): TaskManifest {
  return {
    paramsSchema: {},
    stages: { strategy: "fixed", list: ["全库扫描"] },
    confirm: "skip",
    plan: "optional",
    projects: { min: 0, max: Infinity },
  };
}

export class FakeTaskSkillRegistry implements TaskSkillRegistryPort {
  private readonly entries = new Map<string, { manifest: TaskManifest; description: string }>();

  register(type: string, manifest: TaskManifest, description: string): void {
    this.entries.set(type, { manifest, description });
  }

  getTaskType(type: string): TaskManifest | null {
    return this.entries.get(type)?.manifest ?? null;
  }

  listTaskTypes(): readonly TaskTypeInfo[] {
    return [...this.entries.entries()].map(([type, e]) => ({ type, description: e.description }));
  }
}

export class FakeOrchestratorStarter implements TaskOrchestratorStarterPort {
  readonly starts: string[] = [];
  readonly stops: string[] = [];

  async startOrchestrator(jobId: string): Promise<void> {
    this.starts.push(jobId);
  }

  async stopOrchestrator(jobId: string): Promise<void> {
    this.stops.push(jobId);
  }

  startCount(jobId: string): number {
    return this.starts.filter((id) => id === jobId).length;
  }
}

/** 确定性时钟：now() 每调用一次 +1s（createdAt/updatedAt 可钉）。 */
export function counterClock(baseMs = Date.parse("2026-08-29T10:00:00.000Z")): ClockPort {
  let tick = 0;
  return {
    now: () => new Date(baseMs + tick++ * 1000).toISOString(),
    nowMs: () => baseMs + tick++ * 1000,
  };
}

export interface TaskEngineEnv {
  readonly engine: TaskEngineService;
  readonly query: TaskQueryService;
  readonly store: TaskStore;
  readonly starter: FakeOrchestratorStarter;
  readonly skills: FakeTaskSkillRegistry;
  readonly workLedger: WorkLedgerParentFace;
  readonly dbPath: string;
  dispose(): Promise<void>;
}

export interface TaskEnvOverrides {
  // 当前无覆盖项（kgNodeProjector 已随结果面去 kg 耦合拆除）。
}

/** 真库 + fake 依赖的引擎/查询环境（每 test 独立 tmp home）。 */
export function buildTaskEngineEnv(_over: TaskEnvOverrides = {}): TaskEngineEnv {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-task-engine-"));
  const dbPath = path.join(dir, "helix.db");
  const queue = new WriteQueue(dbPath);
  const store = new TaskStore(queue);
  const workLedger = parentWorkLedger(queue);
  const starter = new FakeOrchestratorStarter();
  const skills = new FakeTaskSkillRegistry();
  skills.register(
    "kg-bootstrap",
    kgBootstrapManifest(),
    "为项目批量创建知识图谱内容（L0 核心层 → L1 领域层 → L2 实体层）；选中项目发起无交互多 agent 知识创建任务时",
  );
  skills.register("zero-project-scan", zeroProjectManifest(), "全库零项目扫描任务");
  const clock = counterClock();
  const engine = new TaskEngineService({ store, skills, starter, workLedger, clock });
  const query = new TaskQueryService({ store, workLedger, skills, clock });
  return {
    engine,
    query,
    store,
    starter,
    skills,
    workLedger,
    dbPath,
    dispose: async () => {
      await queue.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 子进程写面（work_item 直连连接，O-1）：测试造实例 plan 数据用。 */
export function childLedger(dbPath: string): WorkLedger {
  return new WorkLedger(openTaskLedgerDatabase(dbPath));
}

/** 每 test 独立环境执行（隔离 + 自动清理）。 */
export async function withTaskEnv(over: TaskEnvOverrides, fn: (env: TaskEngineEnv) => Promise<void>): Promise<void>;
export async function withTaskEnv(fn: (env: TaskEngineEnv) => Promise<void>): Promise<void>;
export async function withTaskEnv(
  a: TaskEnvOverrides | ((env: TaskEngineEnv) => Promise<void>),
  b?: (env: TaskEngineEnv) => Promise<void>,
): Promise<void> {
  const over = typeof a === "function" ? {} : a;
  const fn = typeof a === "function" ? a : (b as (env: TaskEngineEnv) => Promise<void>);
  const env = buildTaskEngineEnv(over);
  try {
    await fn(env);
  } finally {
    await env.dispose();
  }
}

/** 标准驱动：创建（pending）→ 插批次 → 推阶段 → 派发（running job + running batch）。 */
export async function launchRunningJob(
  env: TaskEngineEnv,
  over: { type?: string; projects?: string[]; params?: Record<string, unknown>; createdBy?: "page" | "chat" } = {},
): Promise<{ jobId: string; batchId: string; scope: string }> {
  const { jobId } = await env.engine.createTask({
    type: over.type ?? "kg-bootstrap",
    projects: over.projects ?? ["demo"],
    params: over.params ?? { projectRoot: "/tmp/demo" },
    createdBy: over.createdBy ?? "page",
  });
  const scope = `批次 1：${(over.projects ?? ["demo"])[0]} L0 探索`;
  const { batchId } = await env.engine.insertBatch({ jobId, stageSeq: 1, scope });
  await env.engine.advanceStage(jobId, 1);
  await env.engine.dispatchBatch(batchId, "inst-a");
  return { jobId, batchId, scope };
}
