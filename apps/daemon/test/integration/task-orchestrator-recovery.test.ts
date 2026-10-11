import { describe, expect, test } from "bun:test";
import {
  withOrchestratorEnv,
  insertBatchEntry,
  spawnEntry,
  dispatchEntry,
  settleInstance,
  type ScriptEntry,
} from "../helpers/orchestrator-fixtures";

/**
 * 编排事故链恢复面集成测（自 task-orchestrator.test.ts 拆分，TR-AD-25 ④ 体量线）：
 * drive 首轮异常重试（task-8659b320）、B1/B2/B3 事故链（fail-stop 停摆 /
 * spawn 闸 / 游离收口可观测 / resume 补派）、迟到接线与挂死批次对账
 * （task-efd68911）、收场推进检查、收口判据读面兜底（code-review M）。
 *
 * 形态同主文件：真 SQLite @ tmp + 剧本化 streamFn 编排会话 + fake spawn 记录器。
 */

const BRIEF_1 = "## 任务目标\n探索 A 模块并产出架构节点（批次 1）。";
const BRIEF_2 = "## 任务目标\n探索 B 模块并产出架构节点（批次 2）。";

// ── 卡装配修复（task-8659b320：首轮 drive 异常静默无重试，job 滞留 pending 6 分钟）──

describe("T2.2 drive 首轮异常 → 单次重试恢复（可观测 + 重试唤醒链）", () => {
  test("drive 首轮抛错 → 5s 重试成功 → 批次照常 spawn；驱动开始/异常/重试全程日志可见", async () => {
    const script: ScriptEntry[] = [
      insertBatchEntry(1, "批次 1：探索 A 模块"),
      { kind: "tool", toolName: "task_advance_stage", args: { stageSeq: 1 } },
      spawnEntry(BRIEF_1),
      dispatchEntry(0, 2),
      { kind: "reply", text: "已派发。" },
      { kind: "tool", toolName: "task_stage_artifact", args: { stageSeq: 1, summary: "L0 层建成。" } },
      { kind: "tool", toolName: "task_complete_job", args: {} },
    ];
    await withOrchestratorEnv({ script, failFirstDrives: 1 }, async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "fake-task",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      // 重试链生效：失败 drive 后 5s 重试 → 批次照常落行 spawn（不再滞留 pending）
      await env.until(() => env.store.getBatches(jobId, 1).length === 1 && env.store.getBatches(jobId, 1).every((b) => b.status === "running"), 15000);
      // 可观测性三段：驱动开始 / 异常+重试宣号 / 重试成功（engine_error 面归 runtime 工厂，此处覆盖 wake 面）
      expect(env.orchestratorLog.some((l) => l.includes("编排会话驱动开始"))).toBe(true);
      expect(env.orchestratorLog.some((l) => l.includes("编排会话驱动异常") && l.includes("scripted drive failure"))).toBe(true);
      expect(env.orchestratorLog.some((l) => l.includes("编排会话重试驱动成功"))).toBe(true);
      // 完整链仍通：收口 → job done
      await settleInstance(env, env.recorder.call(1).agentId, { closure: "done", plan: "resolved" });
      await env.until(() => env.store.getJob(jobId)?.status === "done");
    });
  }, 20000);

  test("drive 连续抛错（重试仍败）→ 放弃本轮；推进检查重驱仍败 → failJob 收口（不再永久滞留 pending）", async () => {
    await withOrchestratorEnv(
      { script: [{ kind: "reply", text: "无动作。" }], failFirstDrives: 99, progressCheckDelayMs: 50 },
      async (env) => {
        const { jobId } = await env.engine.createTask({
          type: "fake-task",
          projects: ["demo"],
          params: { projectRoot: "/tmp/demo" },
          createdBy: "page",
        });
        await env.until(() => env.orchestratorLog.some((l) => l.includes("重试仍失败") || l.includes("放弃本轮")), 20000);
        // 装配期死局兑底：推进检查延迟窗重驱一轮仍败 → failJob 收口 failed
        //（旧行为契约「滞留 pending 等 cancel」已翻转——零批次 = 零 closure 事件 =
        // 零唤醒源，滞留即永久卡「装配中」）
        await env.until(() => env.store.getJob(jobId)?.status === "failed", 20000);
        // 每轮恰一次重试（不无限）：kickoff 轮 + 推进检查重驱轮各 2 次 drive
        expect(env.sessionLog.filter((e) => e.kind === "drive")).toHaveLength(4);
        const job = env.store.getJob(jobId)!;
        expect(job.error).toContain("装配期死局");
        expect(env.store.getBatches(jobId, 1)).toHaveLength(0); // 全程未装配
      },
    );
  }, 45000);

  test("drive 正常收场但编排零动作（k3 形态：剧本只 reply）→ 推进检查重驱仍零动作 → failJob 收口", async () => {
    await withOrchestratorEnv(
      { script: [{ kind: "reply", text: "无法装配。" }], progressCheckDelayMs: 50 },
      async (env) => {
        const { jobId } = await env.engine.createTask({
          type: "fake-task",
          projects: ["demo"],
          params: { projectRoot: "/tmp/demo" },
          createdBy: "page",
        });
        await env.until(() => env.store.getJob(jobId)?.status === "failed", 10000);
        // 重驱恰一次（kickoff + 重驱两轮后零动作收口）
        expect(env.sessionLog.filter((e) => e.kind === "drive" && e.text.includes("推进检查"))).toHaveLength(1);
        expect(env.store.getJob(jobId)!.error).toContain("装配期死局");
        expect(env.store.getBatches(jobId, 1)).toHaveLength(0);
      },
    );
  });

  test("装配期短暂故障自愈：kickoff 两连败放弃后推进检查重驱 → 剧本照常装配 → 任务完成（重驱是给机会非直接杀）", async () => {
    const script: ScriptEntry[] = [
      insertBatchEntry(1, "批次 1：探索 A 模块"),
      { kind: "tool", toolName: "task_advance_stage", args: { stageSeq: 1 } },
      spawnEntry(BRIEF_1),
      dispatchEntry(0, 2),
      { kind: "reply", text: "已派发。" },
      { kind: "tool", toolName: "task_stage_artifact", args: { stageSeq: 1, summary: "L0 层建成。" } },
      { kind: "tool", toolName: "task_complete_job", args: {} },
    ];
    await withOrchestratorEnv({ script, failFirstDrives: 2, progressCheckDelayMs: 50 }, async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "fake-task",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      // kickoff 首轮+重试两连败（注入恰好耗尽）→ 放弃本轮（此时仍 pending 零批次）
      await env.until(() => env.orchestratorLog.some((l) => l.includes("重试仍失败")), 15000);
      // 推进检查延迟窗后重驱 → drive 恢复 → 剧本照常装配（非误杀）
      await env.until(() => env.store.getBatches(jobId, 1).length === 1 && env.store.getBatches(jobId, 1).every((b) => b.status === "running"), 10000);
      await settleInstance(env, env.recorder.call(1).agentId, { closure: "done", plan: "resolved" });
      await env.until(() => env.store.getJob(jobId)?.status === "done");
      // 静默锚（重试失败形态）：失败轮记「驱动开始」不计「驱动完成」（重试经 catch 不记开始）
      // ——完成数 = 开始数 - 1（恰 kickoff 失败轮）时全部回合落定，dispose 关库不撞异步回合
      await env.until(
        () =>
          env.orchestratorLog.filter((l) => l.includes("驱动完成")).length ===
          env.orchestratorLog.filter((l) => l.includes("驱动开始")).length - 1,
      );
    });
  }, 30000);
});

// ── 装配期 LLM 失败（engine_error 终帧形态——drive 不抛错，wake catch 重试不触发）──

/**
 * 真实 LLM 请求失败链路：streamFn error 终帧 → pi loop 正常 agent_end →
 * agent.prompt resolve → drive 正常 resolve——wake 的 catch 重试分支不触发
 *（用户实测「第一次 LLM 请求失败不重试」）；收口只能靠推进检查兑底。
 */
describe("装配期 LLM 失败（engine_error 终帧：drive 不抛错）→ 推进检查兑底", () => {
  test("LLM 持续失败（401 permanent 直透不重试）→ 重驱仍失败 → failJob 收口（不永久卡装配中）", async () => {
    await withOrchestratorEnv(
      { script: [{ kind: "reply", text: "无动作。" }], failFirstLlmCalls: 99, progressCheckDelayMs: 50 },
      async (env) => {
        const { jobId } = await env.engine.createTask({
          type: "fake-task",
          projects: ["demo"],
          params: { projectRoot: "/tmp/demo" },
          createdBy: "page",
        });
        // drive 不抛错：wake catch 重试不触发，每轮恰 1 次 drive（kickoff + 重驱）
        await env.until(() => env.sessionLog.filter((e) => e.kind === "drive").length >= 2, 10000);
        // 推进检查兑底：重驱仍 LLM 失败 → failJob 收口 failed
        await env.until(() => env.store.getJob(jobId)?.status === "failed", 10000);
        expect(env.store.getJob(jobId)!.error).toContain("装配期死局");
        expect(env.store.getBatches(jobId, 1)).toHaveLength(0);
      },
    );
  }, 20000);

  test("LLM 短暂失败自愈：kickoff 一次失败（drive 正常收场）→ 推进检查重驱 → 剧本照常装配 → 任务完成", async () => {
    const script: ScriptEntry[] = [
      insertBatchEntry(1, "批次 1：探索 A 模块"),
      { kind: "tool", toolName: "task_advance_stage", args: { stageSeq: 1 } },
      spawnEntry(BRIEF_1),
      dispatchEntry(0, 2),
      { kind: "reply", text: "已派发。" },
      { kind: "tool", toolName: "task_stage_artifact", args: { stageSeq: 1, summary: "L0 层建成。" } },
      { kind: "tool", toolName: "task_complete_job", args: {} },
    ];
    await withOrchestratorEnv({ script, failFirstLlmCalls: 1, progressCheckDelayMs: 50 }, async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "fake-task",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      // kickoff LLM 失败 → drive 正常 resolve（零抛错）→ 推进检查延迟窗后重驱
      await env.until(() => env.store.getBatches(jobId, 1).length === 1, 10000);
      await settleInstance(env, env.recorder.call(1).agentId, { closure: "done", plan: "resolved" });
      await env.until(() => env.store.getJob(jobId)?.status === "done");
      await env.until(
        () =>
          env.orchestratorLog.filter((l) => l.includes("驱动完成")).length ===
          env.orchestratorLog.filter((l) => l.includes("驱动开始")).length,
      );
    });
  }, 20000);
});

// ── B1/B2/B3 事故链修复：fail-stop 停摆 + spawn 闸 + 游离收口可观测 + resume 补派 ──

describe("B2 fail-stop：failBatch 超限上浮 → haltJob 停摆（摘队排队实例，在跑自然收口）", () => {
  test("三连败上浮 → 停摆摘队 queued + 终态提示恰一次 + 在跑批次收口 done 保留 + drain 自清且不再驱动", async () => {
    const script: ScriptEntry[] = [
      insertBatchEntry(1, "批次 1：探索 A 模块"),
      insertBatchEntry(1, "批次 2：探索 B 模块"),
      { kind: "tool", toolName: "task_advance_stage", args: { stageSeq: 1 } },
      spawnEntry(BRIEF_1),
      spawnEntry(BRIEF_2),
      dispatchEntry(0, 3),
      dispatchEntry(1, 4),
      { kind: "reply", text: "两批已派发，等待收口。" },
    ];
    const onJobTerminal: (jobId: string, status: string) => void = () => undefined;
    const terminals: { jobId: string; status: string }[] = [];
    await withOrchestratorEnv(
      { script, onJobTerminal: (jobId, status) => { terminals.push({ jobId, status }); } },
      async (env) => {
        const { jobId } = await env.engine.createTask({
          type: "fake-task",
          projects: ["demo"],
          params: { projectRoot: "/tmp/demo" },
          createdBy: "page",
        });
        await env.until(() => env.store.getBatches(jobId, 1).length === 2);
        // 批次 2 实例置为排队态（模拟调度 FIFO 未放行——事故链中 wave3 的形态）
        env.recorder.outcomes.set(env.recorder.call(2).agentId, { state: "queued" });
        // 批次 1 三连败：每败一次引擎自动重派（call 3 / call 4），第三次超限上浮
        await settleInstance(env, env.recorder.call(1).agentId, { closure: "failed" });
        await env.until(() => env.recorder.calls.length === 3);
        await settleInstance(env, env.recorder.call(3).agentId, { closure: "failed" });
        await env.until(() => env.recorder.calls.length === 4);
        await settleInstance(env, env.recorder.call(4).agentId, { closure: "failed" });
        await env.until(() => env.store.getJob(jobId)?.status === "failed");
        // fail-stop：排队实例被摘队（killLog 恰为其一，不含在跑/已终态实例）
        expect(env.killLog).toEqual([env.recorder.call(2).agentId]);
        // 终态提示恰一次（前移到停摆点，不等回合结束）
        expect(terminals).toEqual([{ jobId, status: "failed" }]);
        // 停摆后不再驱动编排回合：批次 2 收口（done + 台账全过）前后的 sessionLog 不变
        const logLenBeforeLateSettle = env.sessionLog.length;
        await settleInstance(env, env.recorder.call(2).agentId, { closure: "done", plan: "resolved" });
        // 在跑实例自然收口照常落库（done 保留——人工重试不重跑）
        await env.until(() => env.store.getBatches(jobId, 1).find((b) => b.seq === 2)?.status === "done");
        expect(env.sessionLog.length).toBe(logLenBeforeLateSettle); // closureNotice 被 drain 吞（不驱动）
        // drain 自清：全部 in-flight 收口后循环丢弃（可观测）
        await env.until(() => env.orchestratorLog.some((l) => l.includes("drain 完成")));
      },
    );
    void onJobTerminal;
  }, 15000);
});

describe("B1 spawn 闸：job 非 pending/running 时编排口 spawn 被拒", () => {
  test("paused → spawn rejected；resume → spawn 放行", async () => {
    const script: ScriptEntry[] = [
      insertBatchEntry(1, "批次 1：探索 A 模块"),
      { kind: "tool", toolName: "task_advance_stage", args: { stageSeq: 1 } },
      spawnEntry(BRIEF_1),
      dispatchEntry(0, 2),
      { kind: "reply", text: "已派发。" },
    ];
    await withOrchestratorEnv({ script }, async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "fake-task",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      await env.until(() => env.store.getBatches(jobId, 1).length === 1 && env.store.getBatches(jobId, 1).every((b) => b.status === "running"));
      await env.until(() => env.portOf(jobId) !== undefined);
      const port = env.portOf(jobId)!;
      await env.engine.pause(jobId);
      const rejected = await port.spawn(BRIEF_1);
      expect(rejected.status).toBe("rejected");
      if (rejected.status === "rejected") expect(rejected.error).toContain("不可派发批次实例");
      expect(env.recorder.calls).toHaveLength(1); // 仅批次 1 接线实例，无新 spawn
      await env.engine.resume(jobId);
      const ok = await port.spawn(BRIEF_1);
      expect(ok.status === "run").toBe(true);
      expect(env.recorder.calls).toHaveLength(2);
      // 静默锚：全部 drive 回合落定后再退场（dispose 关库不撞异步回合）
      await env.until(() =>
        env.orchestratorLog.filter((l) => l.includes("驱动完成")).length ===
        env.orchestratorLog.filter((l) => l.includes("驱动开始")).length,
      );
    });
  });
});

describe("B1 游离收口可观测：spawn 未接线批次行 → warn + 纠偏注入（产物丢弃如实宣示）", () => {
  test("游离实例收口 → 日志含丢弃警告 + 编排会话收到派发纠偏注入", async () => {
    const script: ScriptEntry[] = [
      insertBatchEntry(1, "批次 1：探索 A 模块"),
      { kind: "tool", toolName: "task_advance_stage", args: { stageSeq: 1 } },
      spawnEntry(BRIEF_1),
      spawnEntry(BRIEF_2), // 第二次 spawn 不接线（无 dispatchEntry）——游离
      dispatchEntry(0, 2),
      { kind: "reply", text: "已派发。" },
    ];
    await withOrchestratorEnv({ script }, async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "fake-task",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      await env.until(() => env.recorder.calls.length === 2);
      // 游离实例收口（done + 台账全过也无济于事——未接线任何批次行）
      await settleInstance(env, env.recorder.call(2).agentId, { closure: "done", plan: "resolved" });
      await env.until(() => env.orchestratorLog.some((l) => l.includes("游离实例收口被丢弃")));
      expect(env.sessionLog.some((e) => e.text.includes("派发纠偏") && e.text.includes("task_dispatch_batch"))).toBe(true);
      // 接线批次不受牵连：批次 1 仍可正常收口
      await settleInstance(env, env.recorder.call(1).agentId, { closure: "done", plan: "resolved" });
      await env.until(() => env.store.getBatches(jobId, 1).every((b) => b.status === "done"));
      // 静默锚：全部 drive 回合落定后再退场（dispose 关库不撞异步回合）
      await env.until(() =>
        env.orchestratorLog.filter((l) => l.includes("驱动完成")).length ===
        env.orchestratorLog.filter((l) => l.includes("驱动开始")).length,
      );
    });
  });
});

describe("B3 resume 补派回归：暂停期失败未重派批次在 resume 后补派（sweep 先行落行）", () => {
  test("pause 中失败（无重派）→ resume → sweep 补派新实例接线 + 重派补漏注入", async () => {
    const script: ScriptEntry[] = [
      insertBatchEntry(1, "批次 1：探索 A 模块"),
      { kind: "tool", toolName: "task_advance_stage", args: { stageSeq: 1 } },
      spawnEntry(BRIEF_1),
      dispatchEntry(0, 2),
      { kind: "reply", text: "已派发。" },
    ];
    await withOrchestratorEnv({ script }, async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "fake-task",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      await env.until(() => env.store.getBatches(jobId, 1).length === 1 && env.store.getBatches(jobId, 1).every((b) => b.status === "running"));
      const batchId = env.store.getBatches(jobId, 1)[0]!.id;
      // 暂停期失败：引擎直口 failBatch（不经编排收口链 → 无自动重派）
      await env.engine.pause(jobId);
      await env.engine.failBatch(batchId, "closure failed：429 配额耗尽");
      expect(env.recorder.calls).toHaveLength(1); // 暂停期零新增 spawn
      // resume → sweep 补派（retry 1 < 3 有余量）：新实例接线 + 重派补漏注入编排
      await env.engine.resume(jobId);
      await env.until(() => env.recorder.calls.length === 2);
      expect(env.store.getBatch(batchId)).toMatchObject({ status: "running", instanceId: env.recorder.call(2).agentId });
      expect(env.sessionLog.some((e) => e.text.includes("重派补漏"))).toBe(true);
      // 静默锚：全部 drive 回合落定后再退场（dispose 关库不撞异步回合）
      await env.until(() =>
        env.orchestratorLog.filter((l) => l.includes("驱动完成")).length ===
        env.orchestratorLog.filter((l) => l.includes("驱动开始")).length,
      );
    });
  });
});

// ── 迟到接线与挂死批次对账（task-efd68911 事故收敛）──

/**
 * 事故形态：spawn 与 task_dispatch_batch 之间网络故障打死实例 → 收口先到
 * 被判游离丢弃 → 迟到 dispatch 把 running 批次接到终态实例 → 永无人再收口
 * → 批次/job 永久滞留 running。收敛面：引擎守卫转化 + 对账扫描 + 推进检查。
 */
describe("迟到接线与挂死批次对账（task-efd68911 事故收敛）", () => {
  test("收口先于接线（游离丢弃）+ 迟到 dispatch → 引擎守卫转失败收口 + 自动重派新实例 → 任务照常完成", async () => {
    const script: ScriptEntry[] = [
      insertBatchEntry(1, "批次 1：探索 A 模块"),
      { kind: "tool", toolName: "task_advance_stage", args: { stageSeq: 1 } },
      spawnEntry(BRIEF_1),
      { kind: "reply", text: "已 spawn，等收口。" }, // 本轮收场不 dispatch——窗口形成
      dispatchEntry(0, 2), // 下一轮（游离纠偏注入唤醒）迟到接线
      { kind: "reply", text: "已接线。" },
      { kind: "reply", text: "收到重派通知。" },
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
      // 第一轮：插行 + spawn，不接线（窗口形成）——等第一轮驱动收场
      await env.until(() => env.recorder.calls.length === 1);
      await env.until(
        () => env.orchestratorLog.filter((l) => l.includes("驱动完成")).length >= 1,
      );
      // 网络打死实例：收口先到（批次未接线 → 游离丢弃 + 纠偏注入）
      const dead = env.recorder.call(1).agentId;
      env.recorder.outcomes.set(dead, { state: "failed", summary: "engine 收口失败（engine: Connection error.）" });
      env.orchestrator.handleInstanceClosure(dead);
      await env.until(() => env.orchestratorLog.some((l) => l.includes("游离实例收口被丢弃")));
      // 迟到 dispatch：引擎守卫转失败收口 + starter 嵤醒 sweep 重派新实例
      await env.until(() => env.recorder.calls.length === 2);
      const batch = env.store.getBatches(jobId, 1)[0]!;
      expect(batch).toMatchObject({ status: "running", retryCount: 1, instanceId: env.recorder.call(2).agentId });
      expect(batch.retryNote).toContain("已终态");
      // 新实例正常收口 → 聚合 → 完成（事故场景收敛到正常终态）
      await settleInstance(env, env.recorder.call(2).agentId, { closure: "done", plan: "resolved" });
      await env.until(() => env.store.getJob(jobId)?.status === "done");
      // 静默锚
      await env.until(() =>
        env.orchestratorLog.filter((l) => l.includes("驱动完成")).length ===
        env.orchestratorLog.filter((l) => l.includes("驱动开始")).length,
      );
    });
  });

  test("收口链断链（running 批次挂终态实例）→ 驱动回合结束对账补收口 + 重派，不再永久滞留", async () => {
    const script: ScriptEntry[] = [
      insertBatchEntry(1, "批次 1：探索 A 模块"),
      { kind: "tool", toolName: "task_advance_stage", args: { stageSeq: 1 } },
      spawnEntry(BRIEF_1),
      dispatchEntry(0, 2),
      { kind: "reply", text: "已派发。" },
      { kind: "reply", text: "收到对账通知。" },
      { kind: "tool", toolName: "task_stage_artifact", args: { stageSeq: 1, summary: "L0 层建成。" } },
      { kind: "tool", toolName: "task_complete_job", args: {} },
    ];
    await withOrchestratorEnv({ script, progressCheckDelayMs: 50 }, async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "fake-task",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      await env.until(
        () => env.store.getBatches(jobId, 1).length === 1 && env.store.getBatches(jobId, 1).every((b) => b.status === "running"),
      );
      // 收口链断链：实例终态但 closure 通知未达编排（注入回调断）——批次挂死实例
      const dead = env.recorder.call(1).agentId;
      env.recorder.outcomes.set(dead, { state: "failed", summary: "engine 收口失败（engine: Connection error.）" });
      // 不调 handleInstanceClosure（断链模拟）——收场点对账（实例死亡先于收场）
      // 或延迟窗到点对账（死亡晚于收场）双触发兜底
      await env.until(() => env.recorder.calls.length === 2); // 对账重派新实例
      const batch = env.store.getBatches(jobId, 1)[0]!;
      expect(batch).toMatchObject({ status: "running", retryCount: 1, instanceId: env.recorder.call(2).agentId });
      expect(env.orchestratorLog.some((l) => l.includes("对账"))).toBe(true);
      await settleInstance(env, env.recorder.call(2).agentId, { closure: "done", plan: "resolved" });
      await env.until(() => env.store.getJob(jobId)?.status === "done");
      await env.until(() =>
        env.orchestratorLog.filter((l) => l.includes("驱动完成")).length ===
        env.orchestratorLog.filter((l) => l.includes("驱动开始")).length,
      );
    });
  });
});

// ── 编排会话收场后推进检查（无在跑实例 + 未完批次的有界重驱）──

describe("编排收场推进检查（drive 结束点：无在跑实例 + 未完批次 → 重驱一次，仍不推进 failJob）", () => {
  test("LLM 收场未派发（pending 批次无实例）→ 推进检查重驱 → 剧本续跑派发 → 正常完成", async () => {
    const script: ScriptEntry[] = [
      insertBatchEntry(1, "批次 1：探索 A 模块"),
      { kind: "tool", toolName: "task_advance_stage", args: { stageSeq: 1 } },
      { kind: "reply", text: "已划批，稍后派发。" }, // 收场未 spawn——无 wake 源
      spawnEntry(BRIEF_1),
      dispatchEntry(0, 2),
      { kind: "reply", text: "已派发。" },
      { kind: "tool", toolName: "task_stage_artifact", args: { stageSeq: 1, summary: "L0 层建成。" } },
      { kind: "tool", toolName: "task_complete_job", args: {} },
    ];
    await withOrchestratorEnv({ script, progressCheckDelayMs: 50 }, async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "fake-task",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      // 第一轮收场（无在跑实例 + pending 批次）→ 推进检查重驱
      await env.until(() => env.sessionLog.some((e) => e.kind === "drive" && e.text.includes("推进检查")));
      // 重驱轮剧本派发 → 正常链路完成
      await settleInstance(env, env.recorder.call(1).agentId, { closure: "done", plan: "resolved" });
      await env.until(() => env.store.getJob(jobId)?.status === "done");
      await env.until(() =>
        env.orchestratorLog.filter((l) => l.includes("驱动完成")).length ===
        env.orchestratorLog.filter((l) => l.includes("驱动开始")).length,
      );
    });
  });

  test("重驱后仍不推进（剧本只 reply）→ failJob 收口，job 不再永久 running", async () => {
    const script: ScriptEntry[] = [
      insertBatchEntry(1, "批次 1：探索 A 模块"),
      { kind: "tool", toolName: "task_advance_stage", args: { stageSeq: 1 } },
      { kind: "reply", text: "已划批。" },
      { kind: "reply", text: "仍不派发。" }, // 重驱轮仍不推进
    ];
    await withOrchestratorEnv({ script, progressCheckDelayMs: 50 }, async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "fake-task",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      await env.until(() => env.store.getJob(jobId)?.status === "failed");
      expect(env.store.getJob(jobId)!.error).toContain("无法推进");
      await env.until(() =>
        env.orchestratorLog.filter((l) => l.includes("驱动完成")).length ===
        env.orchestratorLog.filter((l) => l.includes("驱动开始")).length,
      );
    });
  });

  test("批次收口后重驱位复位：第二次静置死局再获一次重驱（而非直接 failJob）——任务照常完成", async () => {
    const script: ScriptEntry[] = [
      insertBatchEntry(1, "批次 1：探索 A 模块"),
      { kind: "tool", toolName: "task_advance_stage", args: { stageSeq: 1 } },
      { kind: "reply", text: "已划批，稍后派发。" }, // 第 1 轮收场——静置 1
      spawnEntry(BRIEF_1),
      dispatchEntry(0, 2),
      { kind: "reply", text: "已派发。" }, // 第 2 轮 = 重驱 1 唤醒
      { kind: "reply", text: "收到收口通知，阶段产物稍后申报。" }, // 第 3 轮 = 收口通知唤醒——收场形成静置 2（阶段未完）
      { kind: "tool", toolName: "task_stage_artifact", args: { stageSeq: 1, summary: "L0 层建成。" } }, // 第 4 轮 = 重驱 2 唤醒（复位后重获，未复位则静置 2 直接 failJob）——本轮直接推进收口不再静置
      { kind: "tool", toolName: "task_complete_job", args: {} },
    ];
    await withOrchestratorEnv({ script, progressCheckDelayMs: 50 }, async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "fake-task",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      // 第 1 轮收场 → 静置 1 → 重驱 1（剧本第 2 轮 spawn + dispatch）
      await env.until(() => env.recorder.calls.length === 1); // spawn 已发生
      await env.until(
        () =>
          env.store.getBatches(jobId, 1)[0]?.status === "running" &&
          env.store.getBatches(jobId, 1)[0]?.instanceId === env.recorder.call(1).agentId, // 已接线（未接线 settle 会判游离丢弃）
      );
      // 实例收口（done + resolved）→ 复位 + 收口通知唤醒第 3 轮 → 静置 2
      await settleInstance(env, env.recorder.call(1).agentId, { closure: "done", plan: "resolved" });
      // 复位后第二次静置再获重驱（未复位则 failJob——断言任务最终 done 兑底）
      await env.until(
        () => env.sessionLog.filter((e) => e.kind === "drive" && e.text.includes("推进检查")).length >= 2,
        10000,
      );
      await env.until(() => env.store.getJob(jobId)?.status === "done");
      await env.until(() =>
        env.orchestratorLog.filter((l) => l.includes("驱动完成")).length ===
        env.orchestratorLog.filter((l) => l.includes("驱动开始")).length,
      );
    });
  }, 30000);
});

describe("code-review M：收口判据读面异常并入 try（兜底 failBatch 链不旁路）", () => {
  test("instanceOutcome 读面抛错 → 不逃逸 unhandled rejection，走同一兜底 failBatch + 重派", async () => {
    const script: ScriptEntry[] = [
      insertBatchEntry(1, "批次 1：探索 A 模块"),
      { kind: "tool", toolName: "task_advance_stage", args: { stageSeq: 1 } },
      spawnEntry(BRIEF_1),
      dispatchEntry(0, 2),
      { kind: "reply", text: "已派发。" },
    ];
    // 条件抛错注入：spawn 迟到接线守卫（fixture 内部）也调 instanceOutcome——
    // 派发期须正常返回，仅在收口时刻抛错（ref 委托切换）
    const outcomeRef: { fn: (id: string) => { state: string; summary?: string } | undefined } = {
      fn: () => ({ state: "running" }),
    };
    await withOrchestratorEnv({ script, instanceOutcome: (id) => outcomeRef.fn(id) }, async (env) => {
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
      outcomeRef.fn = (id) => env.recorder.outcomes.get(id) ?? { state: "running" };

      // 收口时刻读面抛错（模拟调度器 status 读面 DB 故障）——原行为：settleInstance
      // 判据读面在 try 外，异常逃逸为 unhandled rejection，兜底 failBatch 不触发，
      // 批次滞留 running（恰是 M5 兜底要防的事故形态）。只对本实例抛——重派
      // spawn 的迟到接线守卫也调 instanceOutcome，其他 id 须正常返回。
      outcomeRef.fn = (id) => {
        if (id === first) throw new Error("注入：closure 判据读面故障（DB 断连）");
        return env.recorder.outcomes.get(id) ?? { state: "running" };
      };
      env.recorder.outcomes.set(first, { state: "done", summary: "批次完成" });
      env.orchestrator.handleInstanceClosure(first);

      // 修复后：读面异常落入同一 catch——退避 5s 兜底 failBatch + 按 retryScheduled 重派
      await env.until(
        () =>
          env.recorder.calls.length >= 2 &&
          env.store.getBatches(jobId, 1)[0]?.status === "running" &&
          env.store.getBatches(jobId, 1)[0]?.instanceId !== first,
        15000, // 兜底退避 5s + 重派链
      );
      expect(env.orchestratorLog.some((m) => m.includes("兜底重试一次 failBatch"))).toBe(true);
      const batch = env.store.getBatches(jobId, 1)[0]!;
      expect(batch.retryNote).toContain("closure 判据读面故障");
    });
  }, 30000);
});

