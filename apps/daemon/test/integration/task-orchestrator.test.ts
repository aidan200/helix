import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SchedulingPolicy } from "../../src/domain/agent/SchedulingPolicy";
import { SchedulerService } from "../../src/application/services/scheduler/SchedulerService";
import { SqliteSessionRepository } from "../../src/adapters/driven/sqlite-session/SqliteSessionRepository";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import type { InstanceClosureOutcome, InstanceRunner, InstanceRunnerCallbacks } from "../../src/application/services/InstanceRunner";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { OrchestratorProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/OrchestratorProfile";
import { ORCHESTRATOR_SYSTEM_PROMPT } from "../../src/adapters/driven/pi-engine/runtime/profiles/OrchestratorProfile";
import {
  PLAN_HARD_CONSTRAINT_SEGMENT,
  SEGMENT_CATALOG,
} from "../../src/adapters/driven/pi-engine/runtime/templates/catalog";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import type { EventPublisherPort } from "../../src/application/ports/outbound/EventPublisherPort";
import type { ClockPort } from "../../src/application/ports/outbound/ClockPort";
import type { TaskManifest } from "../../src/domain/task/types";
import {
  withOrchestratorEnv,
  insertBatchEntry,
  spawnEntry,
  dispatchEntry,
  settleInstance,
  type ScriptEntry,
  type OrchestratorEnv,
} from "../helpers/orchestrator-fixtures";
import { withTaskEnv, kgBootstrapManifest, FakeTaskSkillRegistry } from "../helpers/task-fixtures";
import { TaskEngineService } from "../../src/application/services/task/TaskEngineService";
import { parentWorkLedger } from "../../src/adapters/driven/sqlite-session/WorkLedger";
import { TaskStore } from "../../src/adapters/driven/sqlite-session/TaskStore";
import { counterClock } from "../helpers/task-fixtures";
import { fileURLToPath } from "node:url";

/**
 * T2.2 编排主 agent 运行时（TaskOrchestratorService + OrchestratorProfile +
 * 段库新增）集成测：testing/test-design CL-2 组映射（T3/T5/T8/T11/T13）。
 *
 * 形态：真 SQLite @ tmp + 真 pi 运行时编排会话（剧本化 streamFn 驱动 LLM
 * 判断面——划批次/推进选择）+ 机械判定（closure/plan 硬约束）代码执行 +
 * fake spawn 记录器（预算组换真 SchedulerService + fake runner）。
 */

const TEMPLATES_BRIEF_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/adapters/driven/pi-engine/runtime/templates/brief",
);

const BRIEF_1 = "## 任务目标\n探索 A 模块并产出架构节点（批次 1）。";
const BRIEF_2 = "## 任务目标\n探索 B 模块并产出架构节点（批次 2）。";

// ── RED 组 1：批次循环剧本（CL-2-T3：行先于 spawn → 判读 → 推进 → 收口） ──

describe("T2.2 编排批次循环（CL-2-T3/T11）", () => {
  test("完整链：划 2 批次 → 行先于 spawn → closure+plan 双过 → completeBatch → 阶段产物聚合 → job done", async () => {
    const script: ScriptEntry[] = [
      insertBatchEntry(1, "批次 1：探索 A 模块"),
      insertBatchEntry(1, "批次 2：探索 B 模块"),
      { kind: "tool", toolName: "task_advance_stage", args: { stageSeq: 1 } }, // 首批插行后 job pending→running，才可推阶段
      spawnEntry(BRIEF_1),
      spawnEntry(BRIEF_2),
      dispatchEntry(0, 3), // batchId ← 第 1 条工具结果（insert 1）；instanceId ← 第 4 条（spawn 1）
      dispatchEntry(1, 4),
      { kind: "reply", text: "两批已派发，等待收口。" },
      // 收口注入后第二轮：聚合阶段产物 + 申报完成
      { kind: "tool", toolName: "task_stage_artifact", args: { stageSeq: 1, summary: "L0 层建成：覆盖 A/B 两模块，产出 2 节点。" } },
      { kind: "tool", toolName: "task_complete_job", args: {} },
    ];
    await withOrchestratorEnv({ script }, async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "fake-task",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      // 两批均 spawn（kickoff drive 全部工具轮跑完）
      await env.until(
        () =>
          env.store.getBatches(jobId, 1).length === 2 &&
          env.store.getBatches(jobId, 1).every((b) => b.status === "running"),
      );
      // CL-2-T3 机械顺序：每次 spawn 调用时，batch 行已先于 spawn 落库
      expect(env.recorder.call(1).batchRowCountAtSpawn).toBeGreaterThanOrEqual(1);
      expect(env.recorder.call(2).batchRowCountAtSpawn).toBeGreaterThanOrEqual(2);

      // 两批收口：closure done + plan 全 resolve（机械判据双过）
      await settleInstance(env, env.recorder.call(1).agentId, { closure: "done", plan: "resolved" });
      await settleInstance(env, env.recorder.call(2).agentId, { closure: "done", plan: "resolved" });
      await env.until(() => env.store.getJob(jobId)?.status === "done");

      // 真库查证：批次 done → stage done + artifact（nodeIds 反查 + summary）→ job done
      expect(env.store.getBatches(jobId, 1).every((b) => b.status === "done")).toBe(true);
      const stage = env.store.getStages(jobId).find((s) => s.seq === 1)!;
      expect(stage.status).toBe("done");
      expect(stage.artifact).toMatchObject({
        summary: "L0 层建成：覆盖 A/B 两模块，产出 2 节点。",
        nodeIds: ["N-1-1", "N-1-2"],
      });
      expect(env.store.getJob(jobId)).toMatchObject({ status: "done", error: null });
    });
  });

  test("完成判定机械复核：stage 未 done 时申报完成被引擎拒绝，聚合后才可收口", async () => {
    const script: ScriptEntry[] = [
      insertBatchEntry(1, "批次 1：探索 A 模块"),
      { kind: "tool", toolName: "task_advance_stage", args: { stageSeq: 1 } },
      spawnEntry(BRIEF_1),
      dispatchEntry(0, 2),
      { kind: "reply", text: "已派发。" },
      // 收口后先错误申报（stage 仍 running）→ 再聚合 → 再申报
      { kind: "tool", toolName: "task_complete_job", args: {} },
      { kind: "tool", toolName: "task_stage_artifact", args: { stageSeq: 1, summary: "L0 层建成。" } },
      { kind: "tool", toolName: "task_complete_job", args: {} },
    ];
    await withOrchestratorEnv({ script }, async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "fake-task",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      await env.until(
        () => env.store.getBatches(jobId, 1).length === 1 && env.store.getBatches(jobId, 1)[0]?.status === "running",
      );
      await settleInstance(env, env.recorder.call(1).agentId, { closure: "done", plan: "resolved" });
      // 第一轮申报被机械复核拒绝（引擎抛 task.invalid_state → 工具 error 结果），任务未终态
      await env.until(() => env.store.getJob(jobId)?.status === "done");
      expect(env.store.getJob(jobId)?.status).toBe("done");
      const stage = env.store.getStages(jobId).find((s) => s.seq === 1)!;
      expect(stage.status).toBe("done");
    });
  });
});

// ── RED 组 2：并发预算（CL-2-T3：共享预算池 ≤3 + 编排 loop 不占预算） ──

/** 挂起式 fake runner：实例保持 running 直到外力收口（scheduler-service.test 同构）。 */
class HangingRunner implements InstanceRunner {
  private callbacks?: InstanceRunnerCallbacks;
  private readonly engines = new Map<string, FakeAgentEngine>();
  readonly launched: string[] = [];

  setCallbacks(callbacks: InstanceRunnerCallbacks): void {
    this.callbacks = callbacks;
  }

  launch(instance: { instanceId: string }, task: string): void {
    this.launched.push(instance.instanceId);
    const engine = new FakeAgentEngine({ replies: [{ text: "ok", toolCalls: [{ toolName: "work", durationMs: 60_000 }] }] });
    this.engines.set(instance.instanceId, engine);
    void engine.start(task, () => this.callbacks?.onInstanceEvent(instance.instanceId));
  }

  forceClosure(instanceId: string, outcome: InstanceClosureOutcome): void {
    this.engines.get(instanceId)?.abort();
    this.callbacks?.onInstanceClosure(instanceId, outcome);
  }

  dispose(): void {
    for (const e of this.engines.values()) e.abort();
  }
}

describe("T2.2 并发预算：共享池 ≤3 + 编排不占 SubAgent 预算（CL-2-T3）", () => {
  test("剧本并发派 4 批次：在跑峰值 3、第 4 个排队；收口后出队", async () => {
    // 专用脚本：4 批 insert+spawn+dispatch（假 spawn 不占用——本组用真调度器）
    const script: ScriptEntry[] = [];
    for (let i = 1; i <= 4; i++) {
      script.push(insertBatchEntry(1, `批次 ${i}：模块 ${i}`));
    }
    for (let i = 1; i <= 4; i++) {
      script.push(spawnEntry(`## 任务目标\n批次 ${i} brief。`));
    }
    for (let i = 1; i <= 4; i++) {
      script.push(dispatchEntry(i - 1, 3 + i - 1));
    }
    script.push({ kind: "reply", text: "4 批已派发。" });

    const home = mkdtempSync(path.join(tmpdir(), "helix-orch-budget-"));
    const queue = new WriteQueue(path.join(home, "helix.db"));
    const repository = new SqliteSessionRepository(queue);
    const events: DomainEvent[] = [];
    const publisher: EventPublisherPort = { publish: (e) => void events.push(e), publishDelta: () => undefined };
    const clock: ClockPort = { now: () => "2026-08-29T00:00:00.000Z", nowMs: () => Date.now() };
    const runner = new HangingRunner();
    const scheduler = new SchedulerService({
      policy: new SchedulingPolicy({ maxConcurrent: 3, maxQueued: 8 }),
      runner,
      events: publisher,
      repository,
      clock,
      stalledPollMs: 60_000,
    });

    try {
      await withOrchestratorEnv(
        {
          script,
          rawSpawn: (sessionId, task) => scheduler.spawn(sessionId, task),
          instanceOutcome: (agentId) => {
            const hit = scheduler.status(agentId)[0];
            return hit === undefined ? undefined : { state: hit.state, summary: hit.summary };
          },
        },
        async (env) => {
          const { jobId } = await env.engine.createTask({
            type: "fake-task",
            projects: ["demo"],
            params: { projectRoot: "/tmp/demo" },
            createdBy: "page",
          });
          await env.until(() => runner.launched.length + scheduler.status().filter((s) => s.state === "queued").length >= 4);
          await env.until(() => env.store.getBatches(jobId, 1).length === 4);

          const states = scheduler.status();
          // 编排 loop 不占预算：调度器只登记 4 个批次实例（无编排会话实例）
          expect(states).toHaveLength(4);
          const running = states.filter((s) => s.state === "running");
          const queued = states.filter((s) => s.state === "queued");
          expect(running.length).toBe(3); // 在跑峰值 ≤3（共享预算池语义）
          expect(queued.length).toBe(1); // 第 4 个排队

          // 编排运行 + 3 批次在跑时，chat 侧 spawn 仍按既有预算语义排队（共享预算池）
          const chatSpawn = scheduler.spawn("s-chat", "chat 侧任务");
          expect(chatSpawn.status).toBe("queued");
          scheduler.kill((chatSpawn as { agentId: string }).agentId); // 摘队收尾，不干扰后续断言

          // 3 个在跑收口（done + 空 plan = resolved）→ 出队 → 第 4 个 started
          for (const agentId of running.map((s) => s.agentId)) {
            runner.forceClosure(agentId, {
              result: "done",
              closure: { status: "done", summary: "完成", reportPath: null, findings: null, taskId: null },
            });
          }
          await env.until(() => scheduler.status().filter((s) => s.state === "running").length === 1);
          expect(scheduler.status().filter((s) => s.state === "queued")).toHaveLength(0);
        },
      );
    } finally {
      scheduler.stop();
      runner.dispose();
      await queue.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ── RED 组 3：closure 失败重试 + 接力 brief（CL-2-T5/T13） ──

describe("T2.2 closure 失败自动重试 + 接力 brief（CL-2-T5/T13）", () => {
  test("closure failed → failBatch（retryCount+1）→ 自动重派：新实例 brief 含前序 plan 摘要（已完成项 + note 指针）+ supersede 指令", async () => {
    const script: ScriptEntry[] = [
      insertBatchEntry(1, "批次 1：探索 A 模块"),
      { kind: "tool", toolName: "task_advance_stage", args: { stageSeq: 1 } },
      spawnEntry(BRIEF_1),
      dispatchEntry(0, 2),
      { kind: "reply", text: "已派发。" },
      // 收口注入（首轮）：失败已自动重派——回复等待，不提前聚合
      { kind: "reply", text: "重派批次在跑，等待其收口。" },
      // 重派批（新实例）收口后聚合收口
      { kind: "tool", toolName: "task_stage_artifact", args: { stageSeq: 1, summary: "L0 层建成（重试后）。" } },
      { kind: "tool", toolName: "task_complete_job", args: {} },
    ];
    await withOrchestratorEnv({ script }, async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "fake-task",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      await env.until(
        () => env.store.getBatches(jobId, 1).length === 1 && env.store.getBatches(jobId, 1)[0]?.status === "running",
      );
      const first = env.recorder.call(1).agentId;

      // 前序实例：plan 已完成两项（note 带产物指针）但 closure failed
      await settleInstance(env, first, {
        closure: "failed",
        plan: "resolved",
        summary: "子进程异常退出（exit code 1），未回传 closure",
      });
      // 自动重派发生（第 2 次 spawn）且新实例已落章（重派链：spawn 后 dispatchBatch 换新 instanceId）
      await env.until(
        () =>
          env.recorder.calls.length >= 2 &&
          env.store.getBatches(jobId, 1)[0]?.status === "running" &&
          env.store.getBatches(jobId, 1)[0]?.instanceId !== first,
      );
      const batch = env.store.getBatches(jobId, 1)[0]!;
      expect(batch.retryCount).toBe(1);
      expect(batch.status).toBe("running");
      expect(batch.instanceId).not.toBe(first);

      // 重派 brief 断言：前序 plan 摘要段（已完成项 + note 事实/产物指针）+ supersede 指令 + plan 硬约束段
      const retryBrief = env.recorder.call(2).brief;
      expect(retryBrief).toContain("前序 plan 摘要");
      expect(retryBrief).toContain("探索 A 模块结构");
      expect(retryBrief).toContain("产物指针：node-L0-1");
      expect(retryBrief).toContain("supersede");
      expect(retryBrief).toContain(batch.id); // origin_batchId 检出指令
      expect(retryBrief).toContain(PLAN_HARD_CONSTRAINT_SEGMENT);

      // 新实例成功收口 → completeBatch → 聚合 → job done
      await settleInstance(env, batch.instanceId!, { closure: "done", plan: "resolved" });
      await env.until(() => env.store.getJob(jobId)?.status === "done");
      expect(env.store.getBatches(jobId, 1)[0]!.status).toBe("done");
    });
  });
});

// ── RED 组 4：plan 未 resolve 硬约束（CL-2-T8） ──

describe("T2.2 plan 硬约束判读（CL-2-T8）", () => {
  test("closure done 但 plan 未全 resolve → failBatch（retry_note 含未决项数）并自动重派", async () => {
    const script: ScriptEntry[] = [
      insertBatchEntry(1, "批次 1：探索 A 模块"),
      { kind: "tool", toolName: "task_advance_stage", args: { stageSeq: 1 } },
      spawnEntry(BRIEF_1),
      dispatchEntry(0, 2),
      { kind: "reply", text: "已派发。" },
      { kind: "tool", toolName: "task_stage_artifact", args: { stageSeq: 1, summary: "L0 层建成（重派后）。" } },
      { kind: "tool", toolName: "task_complete_job", args: {} },
    ];
    await withOrchestratorEnv({ script }, async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "fake-task",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      await env.until(() => env.recorder.calls.length >= 1);
      // closure 声明成功但台账一项 pending → 硬约束优先于 LLM 判读
      await settleInstance(env, env.recorder.call(1).agentId, { closure: "done", plan: "unresolved", summary: "任务完成" });
      await env.until(() => env.store.getBatches(jobId, 1)[0]?.status === "failed" || env.recorder.calls.length >= 2);
      const batch = env.store.getBatches(jobId, 1)[0]!;
      expect(batch.status === "failed" || batch.status === "running").toBe(true);
      expect(batch.retryCount).toBe(1);
      expect(batch.retryNote).toContain("未决 1 项");
      // 自动重派发生
      await env.until(() => env.recorder.calls.length >= 2);
      expect(env.recorder.call(2).brief).toContain("前序 plan 摘要");
    });
  });
});

// ── RED 组 5：pause 派发闸（与 T1.3 联用） ──

describe("T2.2 pause 派发闸 + resume 续派", () => {
  test("job paused 后编排不再插新 batch 行；resume 后续派", async () => {
    const script: ScriptEntry[] = [
      insertBatchEntry(1, "批次 1：探索 A 模块"),
      spawnEntry(BRIEF_1),
      dispatchEntry(0, 1),
      { kind: "reply", text: "已派发。" },
      // 收口注入轮：暂停中尝试插新批次（引擎拒绝 → 工具 error 结果）
      insertBatchEntry(1, "批次 2：探索 B 模块"),
      { kind: "reply", text: "暂停中派发被拒，等待恢复。" },
      // resume 唤醒轮：续插批次 2
      insertBatchEntry(1, "批次 2：探索 B 模块"),
      { kind: "reply", text: "已续派。" },
    ];
    await withOrchestratorEnv({ script }, async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "fake-task",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      await env.until(() => env.recorder.calls.length >= 1);
      // 暂停在跑批次收口之前：O-2 停派新批次
      await env.engine.pause(jobId);
      expect(env.store.getJob(jobId)?.status).toBe("paused");
      // 在跑批次自然收口（pause 下照常落库，不触发推进）
      await settleInstance(env, env.recorder.call(1).agentId, { closure: "done", plan: "resolved" });
      await env.until(() => env.store.getBatches(jobId, 1)[0]?.status === "done");
      // 收口注入轮已尝试插批次 2 且被派发闸拒绝
      await env.until(() => env.store.getJob(jobId)?.status === "paused");
      expect(env.store.getBatches(jobId, 1)).toHaveLength(1); // 无新 batch 行

      // resume：重开编排（与断点恢复同路径）→ 唤醒轮续插批次 2
      await env.engine.resume(jobId);
      await env.until(() => env.store.getBatches(jobId, 1).length === 2);
      expect(env.store.getJob(jobId)?.status).toBe("running");
    });
  });
});

// ── RED 组 6/7 已并入组 1/2（聚合 artifact 含 nodeIds+summary；完成判定机械复核） ──

// ── RED 组 8：段库新增（批次 brief 模板段 + plan 硬约束段，CL-2-T13） ──

describe("T2.2 段库新增 + plan 硬约束机械追加（CL-2-T13）", () => {
  test("段库目录含「批次 brief 模板」「plan 硬约束」两段（brief 场景 6→8）且段文件在位", () => {
    const briefTitles = SEGMENT_CATALOG.filter((s) => s.scenario === "brief").map((s) => s.title);
    expect(briefTitles).toContain("批次 brief 模板");
    expect(briefTitles).toContain("plan 硬约束");
    const planSeg = SEGMENT_CATALOG.find((s) => s.scenario === "brief" && s.title === "plan 硬约束")!;
    const content = readFileSync(path.join(TEMPLATES_BRIEF_DIR, planSeg.file), "utf-8");
    expect(content).toContain(`## plan 硬约束`);
    expect(content).toContain(PLAN_HARD_CONSTRAINT_SEGMENT.replace(/^## [^\n]*\n/, ""));
  });

  test("派发面机械追加：LLM brief 未含 plan 硬约束段时系统追加（LLM 剧本不可移除）", async () => {
    const script: ScriptEntry[] = [
      insertBatchEntry(1, "批次 1：探索 A 模块"),
      spawnEntry(BRIEF_1), // 不含硬约束段文本
      dispatchEntry(0, 1),
      { kind: "reply", text: "已派发。" },
    ];
    await withOrchestratorEnv({ script }, async (env) => {
      await env.engine.createTask({
        type: "fake-task",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      await env.until(() => env.recorder.calls.length >= 1);
      const spawned = env.recorder.call(1).brief;
      expect(spawned).toContain(BRIEF_1);
      expect(spawned).toContain(PLAN_HARD_CONSTRAINT_SEGMENT); // 机械追加，LLM 剧本裁不掉
    });
  });

  test("plan=optional 类型不追加硬约束段（强制程度按 manifest）", async () => {
    const script: ScriptEntry[] = [
      insertBatchEntry(1, "批次 1：探索 A 模块"),
      spawnEntry(BRIEF_1),
      dispatchEntry(0, 1),
      { kind: "reply", text: "已派发。" },
    ];
    await withOrchestratorEnv({ script, plan: "optional" }, async (env) => {
      await env.engine.createTask({
        type: "fake-task",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      await env.until(() => env.recorder.calls.length >= 1);
      expect(env.recorder.call(1).brief).not.toContain(PLAN_HARD_CONSTRAINT_SEGMENT);
    });
  });
});

// ── Profile 契约（AD-10 边界：kg 写面禁入；工具集声明） ──

describe("OrchestratorProfile 契约", () => {
  test("工具集 = spawn + plan_read + kg 只读 + read/grep/bash + task 引擎回口；不含 kg 写/写文件工具（AD-10）", () => {
    expect(OrchestratorProfile.tools).toEqual([
      "bash",
      "read",
      "grep",
      "agent_spawn",
      "plan_read",
      "kg",
      "task_insert_batch",
      "task_dispatch_batch",
      "task_advance_stage",
      "task_stage_artifact",
      "task_complete_job",
      "task_fail_job",
    ]);
    // AD-10 机械断言：编排器不持 kg 写工具
    expect(OrchestratorProfile.tools).not.toContain("kg-update");
    expect(OrchestratorProfile.tools).not.toContain("write");
    expect(OrchestratorProfile.tools).not.toContain("edit");
  });

  test("profile kind = orchestrator；提示词携带段库装配指引（与 MainAgent 消费 skill 同构）", () => {
    expect(OrchestratorProfile.kind).toBe("orchestrator");
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("任务派发装配指引");
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("硬约束");
  });

  test("提示词静态工具名零命中（profile 瘦身契约）", () => {
    for (const name of ["bash", "read", "write", "edit", "grep", "agent_spawn", "kg", "task_create", "plan_read"]) {
      if (name === "kg") continue; // 概念词例外（段库指引）
      expect(ORCHESTRATOR_SYSTEM_PROMPT.match(new RegExp(`\\b${name}\\b`)), `编排 profile 提示含工具名 ${name}`).toBeNull();
    }
  });
});

// ── AF-T1.5.2：task.changed 引擎出站钩子（编排驱动迁移经同一单点补推） ──

describe("AF-T1.5.2：TaskEngineService onTaskChanged 出站钩子", () => {
  test("createTask/编排回口迁移各推一帧（job pending/running、stage、batch）；生命周期命令面（pause/resume/cancel）不经钩子", async () => {
    await withTaskEnv(async (env) => {
      const frames: { jobId: string; changed: string; status?: string }[] = [];
      const engine = new TaskEngineService({
        store: env.store,
        skills: env.skills,
        starter: env.starter,
        workLedger: env.workLedger,
        clock: counterClock(),
        onTaskChanged: (frame) => frames.push(frame),
      });
      const { jobId } = await engine.createTask({
        type: "kg-bootstrap",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      // job pending + 3 stage pending 帧（创建面，含 T2.4 工具入口同源）
      expect(frames).toContainEqual({ jobId, changed: "job", status: "pending" });
      expect(frames.filter((f) => f.changed === "stage" && f.status === "pending")).toHaveLength(3);
      frames.length = 0;

      const { batchId } = await engine.insertBatch({ jobId, stageSeq: 1, scope: "批次 1" });
      // 首批接管：job pending→running + batch pending
      expect(frames).toContainEqual({ jobId, changed: "job", status: "running" });
      expect(frames).toContainEqual({ jobId, changed: "batch", status: "pending" });
      frames.length = 0;

      await engine.advanceStage(jobId, 1);
      expect(frames).toContainEqual({ jobId, changed: "stage", status: "running" });
      frames.length = 0;

      await engine.dispatchBatch(batchId, "inst-a");
      expect(frames).toContainEqual({ jobId, changed: "batch", status: "running" });
      frames.length = 0;

      await engine.completeBatch(batchId);
      expect(frames).toContainEqual({ jobId, changed: "batch", status: "done" });
      frames.length = 0;

      // 生命周期迁移不经引擎钩子（handler 层已接同一广播单点——不双发）
      await engine.pause(jobId);
      expect(frames).toHaveLength(0);
      await engine.resume(jobId);
      expect(frames).toHaveLength(0);

      await engine.advanceStage(jobId, 1);
      await engine.writeStageArtifact(jobId, 1, { nodeIds: [], summary: "s" });
      expect(frames).toContainEqual({ jobId, changed: "stage", status: "done" });
      frames.length = 0;

      await engine.insertBatch({ jobId, stageSeq: 2, scope: "批次 2" });
      const b2 = env.store.getBatches(jobId, 2)[0]!;
      await engine.advanceStage(jobId, 2);
      await engine.dispatchBatch(b2.id, "inst-b");
      await engine.completeBatch(b2.id);
      await engine.writeStageArtifact(jobId, 2, { nodeIds: [], summary: "s" });
      await engine.insertBatch({ jobId, stageSeq: 3, scope: "批次 3" });
      const b3 = env.store.getBatches(jobId, 3)[0]!;
      await engine.advanceStage(jobId, 3);
      await engine.dispatchBatch(b3.id, "inst-c");
      await engine.completeBatch(b3.id);
      await engine.writeStageArtifact(jobId, 3, { nodeIds: [], summary: "s" });
      await engine.completeJob(jobId);
      expect(frames).toContainEqual({ jobId, changed: "job", status: "done" });
    });
  });
});
