import { describe, expect, test } from "bun:test";
import {
  withOrchestratorEnv,
  insertBatchEntry,
  spawnEntry,
  type ScriptEntry,
} from "../helpers/orchestrator-fixtures";
import { withTaskEnv, counterClock } from "../helpers/task-fixtures";
import { TaskEngineService } from "../../src/application/services/task/TaskEngineService";

/**
 * 派发原子化（fix A）：agent_spawn 携带 batchId 即机械接线（spawn 与落章
 * 一步完成）——消灭「spawn 后忘记/迟到 task_dispatch_batch」整个失败类
 * （task-be40e407 事故链放大器）。
 *
 * 覆盖：
 * ① spawn+batchId → 批次行即接线（无单独 dispatch 调用）；
 * ② 终态实例接线 → converted-failed 转化 + 引擎重派接力（迟到接线守卫语义不丢）；
 * ③ 无 batchId → 行为与历史一致（不接线）；
 * ④ 同实例重复落章幂等（旧三步补调不报错）；换实例仍拒。
 */

const BRIEF = "## 任务目标\n探索 A 模块并产出架构节点（批次 1）。";

/** 便捷构造：agent_spawn 携带 batchId（batchId 取第 batchResultIdx 条工具结果）。 */
const spawnEntryWithBatch = (brief: string, batchResultIdx: number): ScriptEntry => ({
  kind: "tool",
  toolName: "agent_spawn",
  build: (results) => {
    const batchId = (JSON.parse(results[batchResultIdx]!) as { batchId: string }).batchId;
    return { toolName: "agent_spawn", args: { task: brief, batchId } };
  },
});

describe("派发原子化：agent_spawn 携带 batchId 即接线", () => {
  test("spawn 后批次行即 running+instanceId（零单独 task_dispatch_batch）", async () => {
    const script: ScriptEntry[] = [insertBatchEntry(1, "批次 1：探索 A 模块"), spawnEntryWithBatch(BRIEF, 0), { kind: "reply", text: "已派发。" }];
    await withOrchestratorEnv({ script }, async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "fake-task",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      await env.until(() => env.recorder.calls.length >= 1);
      await env.until(() => env.store.getBatches(jobId, 1)[0]?.instanceId !== null);
      const batch = env.store.getBatches(jobId, 1)[0]!;
      expect(batch.instanceId).toBe(env.recorder.call(1).agentId);
      expect(batch.status).toBe("running");
    });
  });

  test("终态实例接线 → converted-failed 转化（迟到接线守卫）+ 引擎重派接力落新实例", async () => {
    const script: ScriptEntry[] = [insertBatchEntry(1, "批次 1：探索 A 模块"), spawnEntryWithBatch(BRIEF, 0), { kind: "reply", text: "已派发。" }];
    await withOrchestratorEnv(
      {
        script,
        // 首个实例在接线窗口内已终态（boot 瞬死形态）；其余存活
        instanceOutcome: (agentId) => ({ state: agentId === "agent-test-1" ? "failed" : "running" }),
      },
      async (env) => {
        const { jobId } = await env.engine.createTask({
          type: "fake-task",
          projects: ["demo"],
          params: { projectRoot: "/tmp/demo" },
          createdBy: "page",
        });
        await env.until(() => env.recorder.calls.length >= 2);
        await env.until(() => env.store.getBatches(jobId, 1)[0]?.instanceId === "agent-test-2");
        const batch = env.store.getBatches(jobId, 1)[0]!;
        expect(batch.status).toBe("running");
        expect(JSON.stringify(batch)).toContain("迟到接线转化");
      },
    );
  });

  test("无 batchId → 不接线（历史行为回归护栏）", async () => {
    const script: ScriptEntry[] = [insertBatchEntry(1, "批次 1：探索 A 模块"), spawnEntry(BRIEF), { kind: "reply", text: "等待接线指令。" }];
    await withOrchestratorEnv({ script }, async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "fake-task",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      await env.until(() => env.recorder.calls.length >= 1);
      const batch = env.store.getBatches(jobId, 1)[0]!;
      expect(batch.instanceId).toBeNull();
      expect(batch.status).toBe("pending");
    });
  });
});

describe("task_dispatch_batch 幂等接线（旧三步补调不误伤）", () => {
  test("同实例重复落章 no-op；换实例仍拒", async () => {
    await withTaskEnv(async (env) => {
      const engine = new TaskEngineService({
        store: env.store,
        skills: env.skills,
        starter: env.starter,
        workLedger: env.workLedger,
        clock: counterClock(),
      });
      const { jobId } = await engine.createTask({
        type: "kg-bootstrap",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      const { batchId } = await engine.insertBatch({ jobId, stageSeq: 1, scope: "批次 1" });
      expect(await engine.dispatchBatch(batchId, "inst-a")).toEqual({ status: "dispatched" });
      // 幂等：spawn 自动接线后 LLM 按旧三步补调 task_dispatch_batch 不报错
      expect(await engine.dispatchBatch(batchId, "inst-a")).toEqual({ status: "dispatched" });
      const batch = env.store.getBatches(jobId, 1)[0]!;
      expect(batch.instanceId).toBe("inst-a");
      expect(batch.status).toBe("running");
      // 换实例仍拒（不可把 running 批次重接到另一实例）
      await expect(engine.dispatchBatch(batchId, "inst-b")).rejects.toThrow();
    });
  });
});
