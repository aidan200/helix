import { describe, expect, test } from "bun:test";
import type { BatchData, JobData, StageData } from "../../src/application/ports/outbound/TaskStorePort";
import { TaskError } from "../../src/application/services/task/TaskError";
import type { NodeRefData } from "../../src/application/services/task/TaskQueryService";
import { withTaskEnv, childLedger, type TaskEngineEnv } from "../helpers/task-fixtures";

/**
 * TaskQueryService 投影（CL-3-T1 数据面，AD-4②）：
 * 六态任务集 → listTasks 排序（运行中置顶 + 创建时间倒序）+ DTO 字段齐
 * （title 服务端组装非空、progress、error）；过滤面（status/project）；
 * getTaskDetail（阶段条 + 批次 + 实例 plan + currentNarrative 贯穿六态）；
 * getTaskArtifacts（stage.artifact + 节点投影注入面）。
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
  // done（10:03）：全 stage done + artifact
  await s.insertJob(jobOf("job-done", "done", T(3)));
  await s.insertStage(stageOf("job-done", 1, "L0 核心层", "done", { artifact: { nodeIds: ["TR-1", "TR-2"], summary: "L0 完成：核心规则 2 条" } }));
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

  test("getTaskDetail：阶段条 + 当前阶段批次 + 实例 plan + currentNarrative 贯穿六态", async () => {
    await withTaskEnv(async (env) => {
      const ids = await seedSixStates(env);
      const detail = env.query.getTaskDetail(ids.running);
      expect(detail.stages.map((s) => [s.seq, s.name, s.status])).toEqual([
        [1, "L0 核心层", "running"],
        [2, "L1 领域层", "pending"],
      ]);
      // 当前阶段批次列表（running job → L0 两批次）
      expect(detail.batches.map((b) => b.status)).toEqual(["done", "running"]);
      const runningBatch = detail.batches[1]!;
      expect(runningBatch.instanceId).toBe("inst-r2");
      expect(runningBatch.plan?.map((p) => [p.seq, p.content, p.status])).toEqual([
        [1, "扫描 demo 项目符号面", "pending"],
        [2, "落 L0 核心节点", "pending"],
      ]);
      expect(detail.currentNarrative).toContain("L0 核心层");
      expect(detail.params).toEqual({ projectRoot: "/tmp/demo" });
      // 叙述句贯穿六态（抽查 paused/failed）
      expect(env.query.getTaskDetail(ids.paused).currentNarrative).toContain("暂停");
      expect(env.query.getTaskDetail(ids.failed).currentNarrative).toContain("重试耗尽");
      // 不存在 → task.not_found（code 判定）
      try {
        env.query.getTaskDetail("job-none");
        expect.unreachable();
      } catch (error) {
        expect((error as TaskError).code).toBe("task.not_found");
      }
    });
  });

  test("getTaskArtifacts：stage.artifact 投影 + 节点人类可读注入面（AD-4②）", async () => {
    const fakeNodes: NodeRefData[] = [
      { nodeId: "TR-1", name: "会话投影幂等", kind: "rule", digestFirstLine: "投影以种子集合收口。", status: "confirmed" },
      { nodeId: "TR-2", name: "单写通道", kind: "rule", digestFirstLine: "全部写经 WriteQueue。", status: "confirmed" },
    ];
    await withTaskEnv({ kgNodeProjector: (nodeIds) => fakeNodes.filter((n) => nodeIds.includes(n.nodeId)) }, async (env) => {
      const ids = await seedSixStates(env);
      const artifacts = env.query.getTaskArtifacts(ids.done);
      expect(artifacts.stages).toHaveLength(1);
      const stage = artifacts.stages[0]!;
      expect(stage).toMatchObject({ seq: 1, name: "L0 核心层", status: "done" });
      expect(stage.artifact).not.toBeNull();
      expect(stage.artifact!.summary).toBe("L0 完成：核心规则 2 条");
      expect(stage.artifact!.nodes.map((n) => [n.nodeId, n.name, n.kind])).toEqual([
        ["TR-1", "会话投影幂等", "rule"],
        ["TR-2", "单写通道", "rule"],
      ]);
    });
  });

  test("getTaskArtifacts 缺省（无 kg 投影注入）：结构完整不炸，nodes 空投影", async () => {
    await withTaskEnv(async (env) => {
      await env.store.insertJob(jobOf("job-d2", "done", T(9)));
      await env.store.insertStage(
        stageOf("job-d2", 1, "L0 核心层", "done", { artifact: { nodeIds: ["TR-9"], summary: "s" } }),
      );
      const artifacts = env.query.getTaskArtifacts("job-d2");
      expect(artifacts.stages[0]!.artifact).toMatchObject({ summary: "s" });
      expect(artifacts.stages[0]!.artifact!.nodes).toEqual([]);
    });
  });
});
