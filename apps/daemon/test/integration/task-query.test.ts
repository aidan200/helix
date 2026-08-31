import { describe, expect, test } from "bun:test";
import type { BatchData, JobData, StageData } from "../../src/application/ports/outbound/TaskStorePort";
import { TaskError } from "../../src/application/services/task/TaskError";
import { withTaskEnv, childLedger, type TaskEngineEnv } from "../helpers/task-fixtures";

/**
 * TaskQueryService 投影（CL-3-T1 数据面，AD-4②）：
 * 六态任务集 → listTasks 排序（运行中置顶 + 创建时间倒序）+ DTO 字段齐
 * （title 服务端组装非空、progress、error）；过滤面（status/project）；
 * getTaskDetail（阶段条 + 全量批次按 stageSeq 分组键 + 实例 plan）；
 * getTaskArtifacts（stage.artifact 文字报告 { summary }——结果与 kg 零耦合）。
 */

const T = (min: number): string => `2026-08-29T10:${String(min).padStart(2, "0")}:00.000Z`;

function jobOf(id: string, status: JobData["status"], createdAt: string, over: Partial<JobData> = {}): JobData {
  return {
    id,
    type: "kg-bootstrap",
    params: { projectRoot: "/tmp/demo" },
    projects: ["demo"],
    status,
    createdBy: "page",
    createdAt,
    updatedAt: createdAt,
    error: null,
    ...over,
  };
}

function stageOf(jobId: string, seq: number, name: string, status: StageData["status"], over: Partial<StageData> = {}): StageData {
  return { jobId, seq, name, status, artifact: null, updatedAt: T(0), ...over };
}

function batchOf(
  id: string,
  jobId: string,
  stageSeq: number,
  seq: number,
  status: BatchData["status"],
  over: Partial<BatchData> = {},
): BatchData {
  return {
    id,
    jobId,
    stageSeq,
    seq,
    scope: `批次 ${seq}：demo 探索`,
    status,
    retryCount: 0,
    retryNote: null,
    instanceId: null,
    createdAt: T(0),
    updatedAt: T(0),
    ...over,
  };
}

/** 六态任务集（直接行种子：查询服务只读，不走引擎驱动）。 */
interface SixStateIds {
  readonly running: string;
  readonly paused: string;
  readonly pending: string;
  readonly done: string;
  readonly failed: string;
  readonly cancelled: string;
}

async function seedSixStates(env: TaskEngineEnv): Promise<SixStateIds> {
  const s = env.store;
  // running（10:00）：L0 running（批次 1 done + 批次 2 running 带 plan）、L1 pending
  await s.insertJob(jobOf("job-running", "running", T(0)));
  await s.insertStage(stageOf("job-running", 1, "L0 核心层", "running"));
  await s.insertStage(stageOf("job-running", 2, "L1 领域层", "pending"));
  await s.insertBatch(batchOf("bat-r1", "job-running", 1, 1, "done", { instanceId: "inst-r1" }));
  await s.insertBatch(batchOf("bat-r2", "job-running", 1, 2, "running", { instanceId: "inst-r2" }));
  // paused（10:01）
  await s.insertJob(jobOf("job-paused", "paused", T(1)));
  await s.insertStage(stageOf("job-paused", 1, "L0 核心层", "running"));
  // pending（10:02）：未启动（progress null）
  await s.insertJob(jobOf("job-pending", "pending", T(2)));
  await s.insertStage(stageOf("job-pending", 1, "L0 核心层", "pending"));
  // done（10:03）：全 stage done + artifact（两阶段各带批次——全量批次断言面）
  await s.insertJob(jobOf("job-done", "done", T(3)));
  await s.insertStage(stageOf("job-done", 1, "L0 核心层", "done", { artifact: { summary: "L0 完成：核心规则 2 条" } }));
  await s.insertStage(stageOf("job-done", 2, "L1 领域层", "done", { artifact: { summary: "L1 完成：领域 3 域" } }));
  await s.insertBatch(batchOf("bat-d1", "job-done", 1, 1, "done", { instanceId: "inst-d1" }));
  await s.insertBatch(batchOf("bat-d2", "job-done", 1, 2, "done", { instanceId: "inst-d2" }));
  await s.insertBatch(batchOf("bat-d3", "job-done", 2, 1, "done", { instanceId: "inst-d3" }));
  // failed（10:04）
  await s.insertJob(jobOf("job-failed", "failed", T(4), { error: "重试耗尽：批次 demo 探索 3 次失败" }));
  await s.insertStage(stageOf("job-failed", 1, "L0 核心层", "failed"));
  // cancelled（10:05）
  await s.insertJob(jobOf("job-cancelled", "cancelled", T(5)));
  // 在跑批次实例 plan（inst-r2 两条）
  const child = childLedger(env.dbPath);
  await child.insertItems("inst-r2", [
    { seq: 1, content: "扫描 demo 项目符号面" },
    { seq: 2, content: "落 L0 核心节点" },
  ]);
  return {
    running: "job-running",
    paused: "job-paused",
    pending: "job-pending",
    done: "job-done",
    failed: "job-failed",
    cancelled: "job-cancelled",
  } satisfies SixStateIds;
}

describe("TaskQueryService 投影（CL-3-T1 数据面）", () => {
  test("listTasks：运行中置顶 + 创建时间倒序；DTO 字段齐（title 非空/progress/error）", async () => {
    await withTaskEnv(async (env) => {
      const ids = await seedSixStates(env);
      const rows = env.query.listTasks({});
      expect(rows.map((r) => r.jobId)).toEqual([
        ids.running,
        ids.cancelled,
        ids.failed,
        ids.done,
        ids.pending,
        ids.paused,
      ]);
      const running = rows[0]!;
      expect(running).toMatchObject({
        jobId: ids.running,
        type: "kg-bootstrap",
        status: "running",
        projects: ["demo"],
        createdBy: "page",
        createdAt: T(0),
        error: null,
      });
      expect(typeof running.title).toBe("string");
      expect(running.title.length).toBeGreaterThan(0);
      expect(running.title).toContain("demo"); // 标题服务端组装含项目语境
      expect(running.updatedAt).toBeTypeOf("string");
      expect(running.progress).toMatchObject({ stageName: "L0 核心层", batchesDone: 1, batchesTotal: 2 });
      expect(running.progress!.percent).toBe(25); // (0 + 1/2) / 2 阶段
      const failed = rows.find((r) => r.jobId === ids.failed)!;
      expect(failed.error).toContain("重试耗尽");
      expect(failed.progress).not.toBeNull(); // 已推进任务非 null
      const pending = rows.find((r) => r.jobId === ids.pending)!;
      expect(pending.progress).toBeNull(); // 未启动无进度
      const done = rows.find((r) => r.jobId === ids.done)!;
      expect(done.progress).toMatchObject({ stageName: null, percent: 100 });
    });
  });

  test("listTasks 过滤面：status / project 服务端生效", async () => {
    await withTaskEnv(async (env) => {
      const ids = await seedSixStates(env);
      await env.store.insertJob(jobOf("job-other-project", "running", T(6), { projects: ["other"] }));
      const doneRows = env.query.listTasks({ status: "done" });
      expect(doneRows.map((r) => r.jobId)).toEqual([ids.done]);
      const demoRows = env.query.listTasks({ project: "demo" });
      expect(demoRows.every((r) => r.projects.includes("demo"))).toBe(true);
      expect(demoRows.some((r) => r.jobId === "job-other-project")).toBe(false);
    });
  });

  test("getTaskDetail：阶段条 + 全量批次（stageSeq 分组键，跨阶段收集）+ 实例 plan", async () => {
    await withTaskEnv(async (env) => {
      const ids = await seedSixStates(env);
      const detail = env.query.getTaskDetail(ids.running);
      expect(detail.stages.map((s) => [s.seq, s.name, s.status])).toEqual([
        [1, "L0 核心层", "running"],
        [2, "L1 领域层", "pending"],
      ]);
      // 批次带 stageSeq 分组键（running job 仅 stage 1 有两批）
      expect(detail.batches.map((b) => [b.stageSeq, b.seq, b.status])).toEqual([
        [1, 1, "done"],
        [1, 2, "running"],
      ]);
      const runningBatch = detail.batches[1]!;
      expect(runningBatch.instanceId).toBe("inst-r2");
      expect(runningBatch.plan?.map((p) => [p.seq, p.content, p.status])).toEqual([
        [1, "扫描 demo 项目符号面", "pending"],
        [2, "落 L0 核心节点", "pending"],
      ]);
      expect(detail.params).toEqual({ projectRoot: "/tmp/demo" });
      // 叙述句已拆除（裁决 ③）：DTO 无 currentNarrative 字段
      expect(detail).not.toHaveProperty("currentNarrative");
      // done 任务：全部阶段批次返回（不再只是末阶段），按 stage seq + 批次 seq 序
      const doneDetail = env.query.getTaskDetail(ids.done);
      expect(doneDetail.batches.map((b) => [b.stageSeq, b.seq])).toEqual([
        [1, 1],
        [1, 2],
        [2, 1],
      ]);
      // 进度语义不变：仍按当前阶段折算（done 态 100）
      expect(doneDetail.progress).toMatchObject({ stageName: null, percent: 100 });
      // 不存在 → task.not_found（code 判定）
      try {
        env.query.getTaskDetail("job-none");
        expect.unreachable();
      } catch (error) {
        expect((error as TaskError).code).toBe("task.not_found");
      }
    });
  });

  test("getTaskDetail 批次行台账摘要 ledger（P1-⑥ 三径：有台账计数 / 未派发 null / 落章零行 null）", async () => {
    await withTaskEnv(async (env) => {
      const ids = await seedSixStates(env);
      // 推进 inst-r2 台账：#1 → in_progress；#2 → done（计数断言面）
      const child = childLedger(env.dbPath);
      await child.updateItem("inst-r2", 1, "in_progress");
      await child.updateItem("inst-r2", 2, "in_progress");
      await child.updateItem("inst-r2", 2, "done");
      const detail = env.query.getTaskDetail(ids.running);
      // 径 1 有台账：服务端组装计数（AD-4② 前端零拼装）+ plan 全行同源
      const withLedger = detail.batches.find((b) => b.instanceId === "inst-r2")!;
      expect(withLedger.ledger).toEqual({ total: 2, done: 1, inProgress: 1 });
      expect(withLedger.plan?.map((p) => p.seq)).toEqual([1, 2]);
      // 径 2 未派发（instanceId=null）→ ledger=null + plan=null
      await env.store.insertBatch(batchOf("bat-p1", ids.paused, 1, 1, "pending"));
      const pausedDetail = env.query.getTaskDetail(ids.paused);
      expect(pausedDetail.batches[0]!.instanceId).toBeNull();
      expect(pausedDetail.batches[0]!.ledger).toBeNull();
      expect(pausedDetail.batches[0]!.plan).toBeNull();
      // 径 3 落章零行（轻量实例未建 plan；终态清理后同构——deleteTask 连批次行
      // 一起级联清，可见批次只余零行形态）→ 如实 null
      const ledgerless = detail.batches.find((b) => b.instanceId === "inst-r1")!;
      expect(ledgerless.ledger).toBeNull();
      expect(ledgerless.plan).toBeNull();
      // 终态批次台账可读性：任务在即台账在（inst-d1..d3 零行 → null 非炸）
      const doneDetail = env.query.getTaskDetail(ids.done);
      expect(doneDetail.batches.every((b) => b.ledger === null && b.plan === null)).toBe(true);
    });
  });

  test("getTaskDetail 批次行实例调度态 instanceState（⑤ 链 A：parked 徽标数据源；未装配/不在册省略）", async () => {
    await withTaskEnv(
      { instanceStateOf: (agentId) => (agentId === "inst-r2" ? "parked" : agentId === "inst-r1" ? "done" : undefined) },
      async (env) => {
        const ids = await seedSixStates(env);
        const detail = env.query.getTaskDetail(ids.running);
        // 在册实例透出调度态（批次行状态保持 running，实例级态新增透出）
        const parked = detail.batches.find((b) => b.instanceId === "inst-r2")!;
        expect(parked.status).toBe("running");
        expect(parked.instanceState).toBe("parked");
        const doneInst = detail.batches.find((b) => b.instanceId === "inst-r1")!;
        expect(doneInst.instanceState).toBe("done");
        // 不在册（读面 undefined）→ 字段 undefined（wire 上省略，additive）
        await env.store.insertBatch(batchOf("bat-ns1", ids.paused, 1, 1, "running", { instanceId: "inst-gone" }));
        const pausedDetail = env.query.getTaskDetail(ids.paused);
        const gone = pausedDetail.batches.find((b) => b.instanceId === "inst-gone")!;
        expect(gone.instanceState).toBeUndefined();
      },
    );
  });

  test("getTaskArtifacts：stage.artifact 文字报告投影（{ summary }，结果与 kg 零耦合）", async () => {
    await withTaskEnv(async (env) => {
      const ids = await seedSixStates(env);
      const artifacts = env.query.getTaskArtifacts(ids.done);
      expect(artifacts.stages).toHaveLength(2);
      const stage = artifacts.stages[0]!;
      expect(stage).toMatchObject({ seq: 1, name: "L0 核心层", status: "done" });
      // artifact 恰为 { summary }（无 nodes/nodeIds 残留键）
      expect(stage.artifact).toEqual({ summary: "L0 完成：核心规则 2 条" });
      expect(artifacts.stages[1]!.artifact).toEqual({ summary: "L1 完成：领域 3 域" });
      // 未完成阶段 artifact null（空态不炸）
      const running = env.query.getTaskArtifacts(ids.running);
      expect(running.stages.map((s) => s.artifact)).toEqual([null, null]);
    });
  });
});
