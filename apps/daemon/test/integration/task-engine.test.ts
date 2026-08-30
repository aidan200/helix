import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { withTaskEnv, launchRunningJob, childLedger } from "../helpers/task-fixtures";
import { TaskError } from "../../src/application/services/task/TaskError";

/**
 * 任务引擎服务（TaskEngineService，architecture §4；testing/test-design.md 映射）：
 * - CL-1-T6/T4/T5：createTask 全路径（fixed 三阶段落行冻结）、非法 type/params
 *   拒绝不产行、双宿主同源；
 * - CL-3-T7 引擎面：pause（running→paused + 在跑批次照常终态化 + 派发闸）、
 *   cancel（stop + 批次收口 failed 不重试）；
 * - CL-3-T12 引擎面：deleteTask 终态门控 + 四表级联清零 + kg 面零调用；
 * - CL-2-T4 引擎面：恢复扫描（in-flight 批次 failed 收口 + done stage 不重跑 +
 *   starter 重开 + 幂等）；
 * - CL-2-T5 上浮面：failBatch 重试超限上浮 stage/job failed。
 *
 * 真 SQLite @ tmp + 内存 fake starter/skill registry（TR-TEST-4 隔离）。
 */

const ENGINE_SOURCE = fileURLToPath(new URL("../../src/application/services/task/TaskEngineService.ts", import.meta.url));
const STORE_PORT_SOURCE = fileURLToPath(
  new URL("../../src/application/ports/outbound/TaskStorePort.ts", import.meta.url),
);
const ENGINE_PORT_SOURCE = fileURLToPath(
  new URL("../../src/application/ports/inbound/TaskEnginePort.ts", import.meta.url),
);

describe("createTask 全路径（CL-1-T6）", () => {
  test("合法 kg-bootstrap manifest → job 行 pending + stage 三行 pending（冻结）+ 编排启动", async () => {
    await withTaskEnv(async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "kg-bootstrap",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo", scope: "core" },
        createdBy: "page",
      });
      const job = env.store.getJob(jobId);
      expect(job).toBeDefined();
      expect(job).toMatchObject({
        type: "kg-bootstrap",
        status: "pending",
        createdBy: "page",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo", scope: "core" },
        error: null,
      });
      const stages = env.store.getStages(jobId);
      expect(stages.map((s) => [s.seq, s.name, s.status])).toEqual([
        [1, "L0 核心层", "pending"],
        [2, "L1 领域层", "pending"],
        [3, "L2 实体层", "pending"],
      ]);
      expect(stages.every((s) => s.artifact === null)).toBe(true);
      // §5.2：创建成功即装配编排会话（E→O）
      expect(env.starter.starts).toContain(jobId);
    });
  });

  test("stage 冻结机械断言：TaskStorePort/TaskEnginePort 无运行期增删 stage 方法（AD-9③）", async () => {
    const storePort = await readFile(STORE_PORT_SOURCE, "utf8");
    const enginePort = await readFile(ENGINE_PORT_SOURCE, "utf8");
    // 存储端口：stage 面只允许 insertStage（createTask 定格）/updateStageStatus/读
    expect(/deleteStage|removeStage|dropStage/i.test(storePort)).toBe(false);
    // 引擎端口：无任何 stage 行增删方法（阶段计划只在 createTask 内落）
    expect(/deleteStage|removeStage|insertStage/i.test(enginePort)).toBe(false);
  });
});

describe("createTask 校验拒绝（CL-1-T4/T5 集成面，AD-8）", () => {
  test("type 无对应 skill → task.type_unknown 且 job 表无新行", async () => {
    await withTaskEnv(async (env) => {
      const before = env.store.listJobs().length;
      await expect(
        env.engine.createTask({ type: "no-such-type", projects: ["demo"], params: {}, createdBy: "page" }),
      ).rejects.toMatchObject({ code: "task.type_unknown" });
      expect(env.store.listJobs()).toHaveLength(before);
    });
  });

  test("params 违例（缺 required）→ task.validation_failed 且 job 表无新行", async () => {
    await withTaskEnv(async (env) => {
      const before = env.store.listJobs().length;
      await expect(
        env.engine.createTask({ type: "kg-bootstrap", projects: ["demo"], params: {}, createdBy: "page" }),
      ).rejects.toMatchObject({ code: "task.validation_failed" });
      expect(env.store.listJobs()).toHaveLength(before);
    });
  });

  test("projects 基数违例（0 个 / 2 个，manifest 要求恰 1）→ task.validation_failed", async () => {
    await withTaskEnv(async (env) => {
      await expect(
        env.engine.createTask({ type: "kg-bootstrap", projects: [], params: { projectRoot: "/d" }, createdBy: "page" }),
      ).rejects.toMatchObject({ code: "task.validation_failed" });
      await expect(
        env.engine.createTask({
          type: "kg-bootstrap",
          projects: ["a", "b"],
          params: { projectRoot: "/d" },
          createdBy: "page",
        }),
      ).rejects.toMatchObject({ code: "task.validation_failed" });
      expect(env.store.listJobs()).toHaveLength(0);
    });
  });

  test("projects=[] 合法创建（0..n 类型，AD-8）", async () => {
    await withTaskEnv(async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "zero-project-scan",
        projects: [],
        params: {},
        createdBy: "page",
      });
      expect(env.store.getJob(jobId)).toMatchObject({ type: "zero-project-scan", projects: [], status: "pending" });
      expect(env.store.getStages(jobId)).toHaveLength(1);
    });
  });
});

describe("双宿主同源（CL-1-T4）", () => {
  test("createdBy=page/chat 两入口产物同构（type/params/projects/stage 计划一致，仅宿主与 id 异）", async () => {
    await withTaskEnv(async (env) => {
      const input = {
        type: "kg-bootstrap",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
      } as const;
      const fromPage = await env.engine.createTask({ ...input, createdBy: "page" });
      const fromChat = await env.engine.createTask({ ...input, createdBy: "chat" });
      const pageJob = env.store.getJob(fromPage.jobId)!;
      const chatJob = env.store.getJob(fromChat.jobId)!;
      expect(chatJob).toMatchObject({
        type: pageJob.type,
        params: pageJob.params,
        projects: pageJob.projects,
        status: pageJob.status,
      });
      expect(pageJob.createdBy).toBe("page");
      expect(chatJob.createdBy).toBe("chat");
      expect(env.store.getStages(fromChat.jobId).map((s) => s.name)).toEqual(
        env.store.getStages(fromPage.jobId).map((s) => s.name),
      );
    });
  });
});

describe("insertBatch 机械推进 stage（T4.2，AF-T4.1.5 裂口修复）", () => {
  test("stage 首个批次落行 → stage pending→running 机械推进（job pending→running 同构）；后续批次不重复推进", async () => {
    await withTaskEnv(async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "kg-bootstrap",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      expect(env.store.getStages(jobId).map((s) => s.status)).toEqual(["pending", "pending", "pending"]);
      await env.engine.insertBatch({ jobId, stageSeq: 1, scope: "批次 1" });
      // 机械推进：首个批次落行即 stage running（不再依赖编排 LLM 调 advanceStage）
      expect(env.store.getStages(jobId).find((s) => s.seq === 1)!.status).toBe("running");
      // 同 stage 第二批次：stage 保持 running，不报错不重复迁移
      await env.engine.insertBatch({ jobId, stageSeq: 1, scope: "批次 2" });
      expect(env.store.getStages(jobId).find((s) => s.seq === 1)!.status).toBe("running");
      expect(env.store.getBatches(jobId, 1)).toHaveLength(2);
      // 其他 stage 不受影响
      expect(env.store.getStages(jobId).find((s) => s.seq === 2)!.status).toBe("pending");
    });
  });

  test("advanceStage 幂等兼容：机械推进后再调 advanceStage 为 no-op 成功（编排 LLM 冗余调用不炸）", async () => {
    await withTaskEnv(async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "kg-bootstrap",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      await env.engine.insertBatch({ jobId, stageSeq: 1, scope: "批次 1" }); // 机械推进 stage 1 → running
      await env.engine.advanceStage(jobId, 1); // 幂等 no-op（已是 running）
      expect(env.store.getStages(jobId).find((s) => s.seq === 1)!.status).toBe("running");
    });
  });
});

describe("pause 语义（CL-3-T7 引擎面，O-2）", () => {
  test("running → paused 落库；在跑批次 completeBatch 照常落 done；派发闸拒绝新批次；resume 重开编排", async () => {
    await withTaskEnv(async (env) => {
      const { jobId, batchId } = await launchRunningJob(env);
      await env.engine.pause(jobId);
      expect(env.store.getJob(jobId)!.status).toBe("paused");
      // 在跑批次自然收口：照常终态化
      await env.engine.completeBatch(batchId);
      const batches = env.store.getBatches(jobId, 1);
      expect(batches).toHaveLength(1);
      expect(batches[0]!.status).toBe("done");
      // 派发闸：paused 下不产生新 batch 行（引擎面拒绝，T2.2 编排侧同语义）
      await expect(env.engine.insertBatch({ jobId, stageSeq: 2, scope: "新批次" })).rejects.toMatchObject({
        code: "task.invalid_state",
      });
      expect(env.store.getBatches(jobId, 2)).toHaveLength(0);
      // resume：paused→running + startOrchestrator 重开（与恢复同路径）
      const startsBefore = env.starter.startCount(jobId);
      await env.engine.resume(jobId);
      expect(env.store.getJob(jobId)!.status).toBe("running");
      expect(env.starter.startCount(jobId)).toBe(startsBefore + 1);
    });
  });

  test("非 running 暂停 → task.invalid_state；不存在 job → task.not_found", async () => {
    await withTaskEnv(async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "kg-bootstrap",
        projects: ["demo"],
        params: { projectRoot: "/d" },
        createdBy: "page",
      });
      await expect(env.engine.pause(jobId)).rejects.toMatchObject({ code: "task.invalid_state" });
      await expect(env.engine.pause("job-none")).rejects.toMatchObject({ code: "task.not_found" });
    });
  });
});

describe("cancel 语义（CL-3-T7）", () => {
  test("cancel：编排 stop 被调 + job cancelled + 在跑批次标 failed（retry_note=cancelled）", async () => {
    await withTaskEnv(async (env) => {
      const { jobId, batchId } = await launchRunningJob(env);
      await env.engine.cancel(jobId);
      expect(env.starter.stops).toContain(jobId);
      expect(env.store.getJob(jobId)!.status).toBe("cancelled");
      const batch = env.store.getBatch(batchId)!;
      expect(batch.status).toBe("failed");
      expect(batch.retryNote).toContain("cancelled");
    });
  });

  test("cancel 后迟到 failBatch 不触发重试（重试调度前查 job.status）", async () => {
    await withTaskEnv(async (env) => {
      const { jobId, batchId } = await launchRunningJob(env);
      await env.engine.cancel(jobId);
      const outcome = await env.engine.failBatch(batchId, "迟到 closure 失败");
      expect(outcome.retryScheduled).toBe(false);
      const batch = env.store.getBatch(batchId)!;
      expect(batch.status).toBe("failed");
      expect(batch.retryCount).toBe(0);
    });
  });

  test("终态 job cancel → task.invalid_state", async () => {
    await withTaskEnv(async (env) => {
      const { jobId, batchId } = await launchRunningJob(env);
      await env.engine.cancel(jobId);
      await expect(env.engine.cancel(jobId)).rejects.toBeInstanceOf(TaskError);
    });
  });
});

describe("deleteTask（CL-3-T12 引擎面，F3.6）", () => {
  test("running 删除拒绝（task.invalid_state）；cancelled 后删除 → 四表清零 + 他任务不动 + kg 面零调用", async () => {
    await withTaskEnv(async (env) => {
      const { jobId, batchId } = await launchRunningJob(env);
      // 造实例 plan（work_item，子进程直连写面）
      const child = childLedger(env.dbPath);
      await child.insertItems("inst-a", [
        { seq: 1, content: "扫描 demo 项目符号面" },
        { seq: 2, content: "落 L0 核心节点" },
      ]);
      expect(env.workLedger.getItems("inst-a")).toHaveLength(2);
      // 他任务锚点（不受本次删除影响）
      const other = await env.engine.createTask({
        type: "kg-bootstrap",
        projects: ["other"],
        params: { projectRoot: "/o" },
        createdBy: "chat",
      });
      // running 删除拒绝
      await expect(env.engine.deleteTask(jobId)).rejects.toMatchObject({ code: "task.invalid_state" });
      // 终态后删除
      await env.engine.cancel(jobId);
      const { deletedCounts } = await env.engine.deleteTask(jobId);
      expect(deletedCounts).toEqual({ jobs: 1, stages: 3, batches: 1 });
      expect(env.store.getJob(jobId)).toBeUndefined();
      expect(env.store.getStages(jobId)).toHaveLength(0);
      expect(env.store.getBatches(jobId, 1)).toHaveLength(0);
      expect(env.workLedger.getItems("inst-a")).toHaveLength(0); // work_item 一并清（四表清零）
      expect(env.store.getJob(other.jobId)).toBeDefined(); // 他任务不动
      expect(env.store.getStages(other.jobId)).toHaveLength(3);
    });
  });

  test("kg 写面零依赖机械审计：TaskEngineService import 面无 kg（deleteTask 不触 kg）", async () => {
    const source = await readFile(ENGINE_SOURCE, "utf8");
    const imports = source
      .split("\n")
      .filter((line) => line.trim().startsWith("import"))
      .join("\n");
    expect(/kg|knowledge/i.test(imports)).toBe(false);
    expect(/KnowledgeGraph|KgWrite|KgQuery/.test(source)).toBe(false);
  });
});

describe("启动恢复扫描（CL-2-T4 引擎面，F2.3）", () => {
  test("running job（一 done stage + 一 running batch）→ 批次 failed 收口且 retryCount+1、done stage 不重跑、starter 重开", async () => {
    await withTaskEnv(async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "kg-bootstrap",
        projects: ["demo"],
        params: { projectRoot: "/d" },
        createdBy: "page",
      });
      // stage 1 全流程收口 done
      const s1 = await env.engine.insertBatch({ jobId, stageSeq: 1, scope: "批次 1" });
      await env.engine.advanceStage(jobId, 1);
      await env.engine.dispatchBatch(s1.batchId, "inst-1");
      await env.engine.completeBatch(s1.batchId);
      await env.engine.writeStageArtifact(jobId, 1, { nodeIds: ["TR-1"], summary: "L0 完成：核心规则 1 条" });
      // stage 2 in-flight 批次（模拟 daemon 崩溃现场）
      const s2 = await env.engine.insertBatch({ jobId, stageSeq: 2, scope: "批次 2" });
      await env.engine.advanceStage(jobId, 2);
      await env.engine.dispatchBatch(s2.batchId, "inst-2");
      // 恢复
      const startsBefore = env.starter.starts.length;
      const { resumedJobIds } = await env.engine.recoverOnStartup();
      expect(resumedJobIds).toEqual([jobId]);
      expect(env.starter.starts.length).toBe(startsBefore + 1);
      const b2 = env.store.getBatch(s2.batchId)!;
      expect(b2.status).toBe("failed");
      expect(b2.retryCount).toBe(1);
      const stages = env.store.getStages(jobId);
      expect(stages.find((s) => s.seq === 1)!.status).toBe("done"); // done stage 不重跑
      expect(stages.find((s) => s.seq === 1)!.artifact).toEqual({ nodeIds: ["TR-1"], summary: "L0 完成：核心规则 1 条" });
      expect(env.store.getJob(jobId)!.status).toBe("running"); // 重试预算内 job 保持 running
    });
  });

  test("二次调用幂等：零新增 start、resumedJobIds 空（种子集合收口）", async () => {
    await withTaskEnv(async (env) => {
      const { jobId } = await launchRunningJob(env);
      const first = await env.engine.recoverOnStartup();
      expect(first.resumedJobIds).toEqual([jobId]);
      const startsAfterFirst = env.starter.starts.length;
      const second = await env.engine.recoverOnStartup();
      expect(second.resumedJobIds).toEqual([]);
      expect(env.starter.starts.length).toBe(startsAfterFirst);
    });
  });

  test("pending job 一并接管（待编排）；paused 不自动续", async () => {
    await withTaskEnv(async (env) => {
      const pending = await env.engine.createTask({
        type: "kg-bootstrap",
        projects: ["demo"],
        params: { projectRoot: "/d" },
        createdBy: "page",
      });
      const { jobId: pausedJob } = await launchRunningJob(env, {
        projects: ["p2"],
        params: { projectRoot: "/p2" },
      });
      await env.engine.pause(pausedJob);
      const { resumedJobIds } = await env.engine.recoverOnStartup();
      expect(resumedJobIds).toContain(pending.jobId);
      expect(resumedJobIds).not.toContain(pausedJob);
    });
  });
});

describe("重试超限上浮（CL-2-T5 上浮面，O-3）", () => {
  test("failBatch 第三次后 batch/stage/job 全 failed（error 含批次 scope 与 retryCount）", async () => {
    await withTaskEnv(async (env) => {
      const { jobId, batchId, scope } = await launchRunningJob(env);
      // 第 1 次失败：retryScheduled + failed 落库
      const r1 = await env.engine.failBatch(batchId, "closure 失败（一）");
      expect(r1.retryScheduled).toBe(true);
      expect(env.store.getBatch(batchId)).toMatchObject({ status: "failed", retryCount: 1 });
      // 自动重派：failed→running（AF-1.3）+ 新实例落章
      await env.engine.dispatchBatch(batchId, "inst-b");
      expect(env.store.getBatch(batchId)).toMatchObject({ status: "running", instanceId: "inst-b" });
      // 第 2 次失败
      const r2 = await env.engine.failBatch(batchId, "closure 失败（二）");
      expect(r2.retryScheduled).toBe(true);
      expect(env.store.getBatch(batchId)).toMatchObject({ status: "failed", retryCount: 2 });
      await env.engine.dispatchBatch(batchId, "inst-c");
      // 第 3 次失败：超限上浮
      const r3 = await env.engine.failBatch(batchId, "closure 失败（三）");
      expect(r3.retryScheduled).toBe(false);
      expect(env.store.getBatch(batchId)).toMatchObject({ status: "failed", retryCount: 3 });
      expect(env.store.getStages(jobId).find((s) => s.seq === 1)!.status).toBe("failed");
      const job = env.store.getJob(jobId)!;
      expect(job.status).toBe("failed");
      expect(job.error).toContain(scope);
      expect(job.error).toContain("3");
    });
  });
});

describe("job 收口回口（completeJob 机械复核）", () => {
  test("全 stage done → completeJob 落 done；有未 done stage → task.invalid_state", async () => {
    await withTaskEnv(async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "kg-bootstrap",
        projects: ["demo"],
        params: { projectRoot: "/d" },
        createdBy: "page",
      });
      await expect(env.engine.completeJob(jobId)).rejects.toMatchObject({ code: "task.invalid_state" });
      // 编排接管（首批次落行翻 running）后逐阶段收口
      await env.engine.insertBatch({ jobId, stageSeq: 1, scope: "批次 1" });
      for (const seq of [1, 2, 3]) {
        await env.engine.advanceStage(jobId, seq);
        await env.engine.writeStageArtifact(jobId, seq, { nodeIds: [], summary: `阶段 ${seq} 完成` });
      }
      await env.engine.completeJob(jobId);
      expect(env.store.getJob(jobId)!.status).toBe("done");
      // failJob 收口
      const other = await launchRunningJob(env, { projects: ["x"], params: { projectRoot: "/x" } });
      await env.engine.failJob(other.jobId, "编排申报不可恢复失败");
      expect(env.store.getJob(other.jobId)).toMatchObject({ status: "failed", error: "编排申报不可恢复失败" });
    });
  });
});
