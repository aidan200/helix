/**
 * 任务引擎服务（TaskEngineService）收口与派发面：job 收口回口（completeJob
 * 机械复核）/ 接管激活对称与阶段顺序守卫 / dispatchBatch 实例终态守卫 /
 * 阶段角色门与装配完成申报 / store 守卫拒绝上抛。
 * 纯位置迁移自 task-engine.test.ts（P1 体量门拆分批，测试逻辑/断言零改动）。
 */
import { describe, expect, test } from "bun:test";
import { withTaskEnv, launchRunningJob, type TaskEngineEnv } from "../helpers/task-fixtures";
import { TaskError } from "../../src/application/services/task/TaskError";
import type { InstanceState } from "../../src/domain/agent/AgentInstance";

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
      // 编排接管后逐阶段收口（A-2 角色门：execute 阶段产物须批次全收口）
      for (const seq of [1, 2, 3]) {
        const { batchId } = await env.engine.insertBatch({ jobId, stageSeq: seq, scope: `批次 ${seq}` });
        await env.engine.advanceStage(jobId, seq);
        await env.engine.dispatchBatch(batchId, `inst-${seq}`);
        await env.engine.completeBatch(batchId);
        await env.engine.writeStageArtifact(jobId, seq, { summary: `阶段 ${seq} 完成` });
      }
      await env.engine.completeJob(jobId);
      expect(env.store.getJob(jobId)!.status).toBe("done");
      // failJob 收口
      const other = await launchRunningJob(env, { projects: ["x"], params: { projectRoot: "/x" } });
      await env.engine.failJob(other.jobId, "编排申报不可恢复失败");
      expect(env.store.getJob(other.jobId)).toMatchObject({ status: "failed", error: "编排申报不可恢复失败" });
    });
  });

  test("pending job failJob → 桥接两段落定 failed（装配期死局收口：pending→running→failed 同步链，观察者见终值）", async () => {
    await withTaskEnv(async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "kg-bootstrap",
        projects: ["demo"],
        params: { projectRoot: "/d" },
        createdBy: "page",
      });
      await env.engine.failJob(jobId, "装配期死局：编排会话持续无法驱动");
      expect(env.store.getJob(jobId)).toMatchObject({
        status: "failed",
        error: "装配期死局：编排会话持续无法驱动",
      });
      // stage 行不迁（failJob 仅迁 job 行——pending stage 有合法出边，人工 retry 后编排接管自然推进）
      expect(env.store.getStages(jobId).every((s) => s.status === "pending")).toBe(true);
      // 终态后拒绝重入（幂等保护：仅 pending/running 可收口）
      await expect(env.engine.failJob(jobId, "再次失败")).rejects.toMatchObject({ code: "task.invalid_state" });
    });
  });
});

describe("接管激活对称与阶段顺序守卫（B 批：激活放宽 + O-2 文案 + 防跳段）", () => {
  test("pending job 上 advanceStage → 接管激活（job→running）+ stage pending→running（8213de82 死锁修复：推进动作不再被误拒）", async () => {
    await withTaskEnv(async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "kg-bootstrap",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      await env.engine.advanceStage(jobId, 1);
      expect(env.store.getJob(jobId)!.status).toBe("running");
      expect(env.store.getStages(jobId).find((s) => s.seq === 1)!.status).toBe("running");
    });
  });

  test("pending job 上 writeStageArtifact（plan 角色）→ 接管激活 + pending 阶段自动两步落 done（直执阶段免显式 advance）", async () => {
    await withTaskEnv(async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "plan-execute-demo",
        projects: [],
        params: {},
        createdBy: "page",
      });
      await env.engine.writeStageArtifact(jobId, 1, { summary: "阶段一产物" });
      expect(env.store.getJob(jobId)!.status).toBe("running");
      const stage = env.store.getStages(jobId).find((s) => s.seq === 1)!;
      expect(stage.status).toBe("done");
      expect(stage.artifact).toMatchObject({ summary: "阶段一产物" });
    });
  });

  test("O-2 文案修正：paused 拒绝推进且文案准确（不再把状态笼统误标，指引 resume）", async () => {
    await withTaskEnv(async (env) => {
      const { jobId } = await launchRunningJob(env);
      await env.engine.pause(jobId);
      const err: TaskError = await env.engine.advanceStage(jobId, 2).catch((e) => e);
      expect(err.code).toBe("task.invalid_state");
      expect(err.message).toContain("已暂停");
      expect(err.message).not.toContain("（暂停/终态不执行推进动作，O-2）");
    });
  });

  test("阶段顺序守卫：前序阶段未 done 时 insertBatch/advanceStage/writeStageArtifact 全拒（机械防跳段）", async () => {
    await withTaskEnv(async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "kg-bootstrap",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      await expect(env.engine.insertBatch({ jobId, stageSeq: 2, scope: "跳段批次" })).rejects.toMatchObject({ code: "task.invalid_state" });
      await expect(env.engine.advanceStage(jobId, 2)).rejects.toMatchObject({ code: "task.invalid_state" });
      await expect(env.engine.writeStageArtifact(jobId, 2, { summary: "x" })).rejects.toMatchObject({ code: "task.invalid_state" });
      expect(env.store.getBatches(jobId, 2)).toHaveLength(0);
    });
  });

  test("前序全 done 后放行：plan 阶段产物落 done → execute 阶段插批/推进不再被守卫拦截", async () => {
    await withTaskEnv(async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "plan-execute-demo",
        projects: [],
        params: {},
        createdBy: "page",
      });
      await env.engine.writeStageArtifact(jobId, 1, { summary: "一阶段完成" });
      await env.engine.insertBatch({ jobId, stageSeq: 2, scope: "二阶段批次" });
      expect(env.store.getBatches(jobId, 2)).toHaveLength(1);
      await env.engine.advanceStage(jobId, 2); // 幂等 no-op（已随首批次机械推 running）
      expect(env.store.getStages(jobId).find((s) => s.seq === 2)!.status).toBe("running");
    });
  });
});

/**
 * dispatchBatch 实例终态守卫（task-efd68911 迟到接线事故收敛）：
 * 事故链：spawn 与 task_dispatch_batch 是两个独立事件，网络故障恰在窗口内
 * 打死实例 → 收口先到被判「游离」丢弃 → 迟到 dispatch 把 running 批次接到
 * 终态实例上 → 永远无人再收口 → 批次/job 永久滞留 running。
 * 守卫面（instanceStateOf 装配时生效）：终态实例 → 不落 running，转
 * failBatch 失败收口（重派归编排 sweepRetries，经 starter.startOrchestrator
 * 幂等唤醒触发）；查无实例（幽灵 id）→ 拒绝（防接线不存在的实例同样死锁）。
 */
describe("dispatchBatch 实例终态守卫（task-efd68911 迟到接线事故）", () => {
  const statesOf =
    (map: Record<string, InstanceState>): ((agentId: string) => InstanceState | undefined) =>
    (agentId) =>
      map[agentId];

  async function setupJob(env: TaskEngineEnv) {
    const { jobId } = await env.engine.createTask({
      type: "kg-bootstrap",
      projects: ["demo"],
      params: { projectRoot: "/tmp/demo" },
      createdBy: "page",
    });
    const { batchId } = await env.engine.insertBatch({ jobId, stageSeq: 1, scope: "批次 1：探索" });
    await env.engine.advanceStage(jobId, 1);
    return { jobId, batchId };
  }

  test("接线终态实例 → 不落 running：转失败收口（failed+retryCount=1+note）+ 唤醒编排补派", async () => {
    await withTaskEnv({ instanceStateOf: statesOf({ "agent-dead": "failed" }) }, async (env) => {
      const { jobId, batchId } = await setupJob(env);
      const out = await env.engine.dispatchBatch(batchId, "agent-dead");
      expect(out).toMatchObject({ status: "converted-failed", retryScheduled: true });
      const batch = env.store.getBatch(batchId)!;
      expect(batch.status).toBe("failed"); // 未进 running
      expect(batch.instanceId).toBeNull(); // 未接线死实例
      expect(batch.retryCount).toBe(1);
      expect(batch.retryNote).toContain("已终态");
      // 转化后重派归编排：starter 幂等唤醒（existing loop → sweepRetries 补派）
      expect(env.starter.starts).toContain(jobId);
    });
  });

  test("转化路径重试耗尽同口上浮：job failed + haltJob 停摆", async () => {
    await withTaskEnv(
      { instanceStateOf: statesOf({ "inst-live": "queued", "agent-dead": "failed" }) },
      async (env) => {
        const { jobId, batchId } = await setupJob(env);
        // 两轮正常失败收口（retryCount=2，预算内）
        await env.engine.dispatchBatch(batchId, "inst-live");
        await env.engine.failBatch(batchId, "第一轮失败");
        await env.engine.dispatchBatch(batchId, "inst-live");
        await env.engine.failBatch(batchId, "第二轮失败");
        // 第三次接线终态实例 → 转化路径 retryCount=3 ≥ 上限 → 上浮
        const out = await env.engine.dispatchBatch(batchId, "agent-dead");
        expect(out).toMatchObject({ status: "converted-failed", retryScheduled: false });
        expect(env.store.getJob(jobId)!.status).toBe("failed");
        expect(env.starter.halts).toContain(jobId);
      },
    );
  });

  test("接线查无实例（幽灵 id）→ task.invalid_state 拒绝，批次留 pending 不接线", async () => {
    await withTaskEnv({ instanceStateOf: () => undefined }, async (env) => {
      const { batchId } = await setupJob(env);
      await expect(env.engine.dispatchBatch(batchId, "agent-ghost")).rejects.toMatchObject({
        code: "task.invalid_state",
      });
      const batch = env.store.getBatch(batchId)!;
      expect(batch.status).toBe("pending");
      expect(batch.instanceId).toBeNull();
    });
  });

  test("终态转化只对可派发态（pending/failed）：已 done 批次补调 dispatch → 拒绝，不把 done 回退 running/failed", async () => {
    // 评审 F1：转化路径原无态限定——批次已 done 后 LLM 仍按旧三步补调
    // task_dispatch_batch（携已收口实例），守卫把 done 行改写成 running 再
    // failBatch，把「已完成」倒灌成「失败」。可派发态限定后：done 直接由
    // assertBatchRunnable 拒绝（invalid_state），行状态零迁移。
    await withTaskEnv(
      { instanceStateOf: statesOf({ "inst-live": "running", "agent-dead": "done" }) },
      async (env) => {
        const { batchId } = await setupJob(env);
        await env.engine.dispatchBatch(batchId, "inst-live");
        await env.engine.completeBatch(batchId);
        await expect(env.engine.dispatchBatch(batchId, "agent-dead")).rejects.toMatchObject({
          code: "task.invalid_state",
        });
        expect(env.store.getBatch(batchId)!).toMatchObject({ status: "done", instanceId: "inst-live" });
      },
    );
  });

  test("running 批次不可换接到终态实例（在跑工作不被倒灌失败）：实例面与批次面均不动", async () => {
    // 评审 F1：同实例重复落章在上方幂等短路；但换实例 + 新实例已终态时会走进
    // 转化路径——把在跑的 running 批次 instanceId 置 null 再 failBatch，真实
    // 在飞实例的收口随后被判「游离丢弃」，批次永久 failed。可派发态限定后拒。
    await withTaskEnv(
      { instanceStateOf: statesOf({ "inst-live": "running", "agent-dead": "cancelled" }) },
      async (env) => {
        const { batchId } = await setupJob(env);
        await env.engine.dispatchBatch(batchId, "inst-live");
        await expect(env.engine.dispatchBatch(batchId, "agent-dead")).rejects.toMatchObject({
          code: "task.invalid_state",
        });
        expect(env.store.getBatch(batchId)!).toMatchObject({ status: "running", instanceId: "inst-live" });
      },
    );
  });

  test("queued/running 实例照常接线（守卫不误伤正常派发）", async () => {
    await withTaskEnv(
      { instanceStateOf: statesOf({ "inst-live": "queued", "inst-run": "running" }) },
      async (env) => {
        const { batchId } = await setupJob(env);
        const out = await env.engine.dispatchBatch(batchId, "inst-live");
        expect(out).toMatchObject({ status: "dispatched" });
        expect(env.store.getBatch(batchId)!).toMatchObject({ status: "running", instanceId: "inst-live" });
      },
    );
  });
});

describe("阶段角色门与装配完成申报（A 批：kind 机械约束 + 第四 wake 点）", () => {
  test("plan/aggregate 阶段拒插批（机械禁止探针批次混入直执阶段，7466ce9e 实证）；plan 产物即判据零批次可聚合", async () => {
    await withTaskEnv(async (env) => {
      const { jobId } = await env.engine.createTask({ type: "plan-execute-demo", projects: [], params: {}, createdBy: "page" });
      await expect(env.engine.insertBatch({ jobId, stageSeq: 1, scope: "盘点阶段插批" })).rejects.toMatchObject({ code: "task.invalid_state" });
      await env.engine.writeStageArtifact(jobId, 1, { summary: "底账完成" });
      expect(env.store.getStages(jobId).find((s) => s.seq === 1)!.status).toBe("done");
      await env.engine.insertBatch({ jobId, stageSeq: 2, scope: "执行批次" });
      expect(env.store.getBatches(jobId, 2)).toHaveLength(1);
      await expect(env.engine.insertBatch({ jobId, stageSeq: 3, scope: "汇总插批" })).rejects.toMatchObject({ code: "task.invalid_state" });
    });
  });

  test("execute 阶段产物聚合须批次全收口：零批次拒、在跑拒、全 done 放行", async () => {
    await withTaskEnv(async (env) => {
      const { jobId } = await env.engine.createTask({ type: "plan-execute-demo", projects: [], params: {}, createdBy: "page" });
      await env.engine.writeStageArtifact(jobId, 1, { summary: "底账完成" });
      await expect(env.engine.writeStageArtifact(jobId, 2, { summary: "x" })).rejects.toMatchObject({ code: "task.invalid_state" }); // 零批次
      const { batchId } = await env.engine.insertBatch({ jobId, stageSeq: 2, scope: "执行批次" });
      await env.engine.dispatchBatch(batchId, "inst-x");
      await expect(env.engine.writeStageArtifact(jobId, 2, { summary: "x" })).rejects.toMatchObject({ code: "task.invalid_state" }); // 在跑未收口
      await env.engine.completeBatch(batchId);
      await env.engine.writeStageArtifact(jobId, 2, { summary: "二阶段完成" });
      expect(env.store.getStages(jobId).find((s) => s.seq === 2)!.status).toBe("done");
    });
  });

  test("assemblyDone：机械校验通过触发 onAssemblyDone 钩子（batchCount 如实）；plan 角色/零批次拒绝（前序守卫与 insert 共用，B 批已测）", async () => {
    const wakes: Array<{ jobId: string; stageSeq: number; batchCount: number }> = [];
    await withTaskEnv({ onAssemblyDone: (jobId, stageSeq, batchCount) => wakes.push({ jobId, stageSeq, batchCount }) }, async (env) => {
      const { jobId } = await env.engine.createTask({ type: "plan-execute-demo", projects: [], params: {}, createdBy: "page" });
      await expect(env.engine.assemblyDone(jobId, 1)).rejects.toMatchObject({ code: "task.invalid_state" }); // plan 角色无装配物
      await expect(env.engine.assemblyDone(jobId, 2)).rejects.toMatchObject({ code: "task.invalid_state" }); // 零批次
      await env.engine.writeStageArtifact(jobId, 1, { summary: "底账完成" });
      await env.engine.insertBatch({ jobId, stageSeq: 2, scope: "批一" });
      await env.engine.insertBatch({ jobId, stageSeq: 2, scope: "批二" });
      const result = await env.engine.assemblyDone(jobId, 2);
      expect(result).toEqual({ batchCount: 2 });
      expect(wakes).toEqual([{ jobId, stageSeq: 2, batchCount: 2 }]);
      // 行状态零迁移：阶段已随首批次 running，申报本身不落状态
      expect(env.store.getStages(jobId).find((s) => s.seq === 2)!.status).toBe("running");
    });
  });
});

describe("store 守卫拒绝上抛（mapDomainError 吞错回归，review B4）", () => {
  // TaskEngineService 七处 `.catch((error) => this.mapDomainError(error))` 形态：
  // mapDomainError 对 DomainError 是 return 而非 throw——.catch 把返回值当恢复值，
  // store 迁移守卫拒绝（非法迁移/行不存在）被静默吞掉、方法照常返回成功
  //（与 transitionJob :813 的正确 `throw this.mapDomainError(e)` 自相矛盾）。
  test("writeStageArtifact 重复聚合已 done 阶段 → done→done 守卫拒绝须上抛 task.invalid_state，不得静默成功", async () => {
    await withTaskEnv(async (env) => {
      const { jobId, batchId } = await launchRunningJob(env); // stage1 running + batch running
      await env.engine.completeBatch(batchId);
      await env.engine.writeStageArtifact(jobId, 1, { summary: "L0 完成" });
      expect(env.store.getStages(jobId).find((s) => s.seq === 1)!.status).toBe("done");
      // 重复聚合：assertStageTransition(done→done) 拒绝——吞错缺陷下本调用
      // 假装成功（产物未落库），修复后须上抛 TaskError
      await expect(env.engine.writeStageArtifact(jobId, 1, { summary: "重复申报" })).rejects.toMatchObject({
        code: "task.invalid_state",
      });
      // 原产物不被第二次申报覆盖（吞错时静默丢弃新产物）
      expect(env.store.getStages(jobId).find((s) => s.seq === 1)!.artifact).toEqual({ summary: "L0 完成" });
    });
  });

  test("cancel 对已 done 阶段不触达守卫（回归护栏：修复不改变 cancel 幂等收口语义）", async () => {
    await withTaskEnv(async (env) => {
      const { jobId, batchId } = await launchRunningJob(env);
      await env.engine.completeBatch(batchId);
      await env.engine.writeStageArtifact(jobId, 1, { summary: "L0 完成" });
      await env.engine.cancel(jobId); // done stage 被 isTerminalStage 跳过，不进吞错面
      expect(env.store.getJob(jobId)!.status).toBe("cancelled");
    });
  });
});
