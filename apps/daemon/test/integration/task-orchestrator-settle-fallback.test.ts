/**
 * 收口兜底分支据实收口回归（评审 F1）。
 *
 * 缺陷形态：主路径 failBatch **已成功**（批次行已落 failed），其后的 reDispatch
 * 内 rawSpawn 抛错 → 落进 settleInstance 外层 catch → 退避 5s 后兜底 failBatch
 * 再对同一批次调一次（仅 running 可收口 failed → 必抛）→ retryErr 分支给出
 * 「批次滞留 running，需人工介入」的 verdict 与 warn：与实际行状态（failed）
 * 相反，且把可由引擎补派/对账自愈的场面标成需人工介入。
 *
 * 现行语义：外层 catch 先复读批次行——已非 running（主路径已落定终态）时不再做
 * 无意义的退避重试，据实报「收口已落库 + 重派异常」，补派交编排收场对账
 *（sweepBatches）/ 引擎重试扫描接续。
 */
import { describe, expect, test } from "bun:test";
import {
  withOrchestratorEnv,
  insertBatchEntry,
  spawnEntry,
  dispatchEntry,
  settleInstance,
  type ScriptEntry,
} from "../helpers/orchestrator-fixtures";

const BRIEF_1 = "## 任务目标\n探索 A 模块并产出架构节点（批次 1）。";

describe("settleInstance 兜底分支（评审 F1）：批次已终态时报文据实，不谎报滞留 running", () => {
  test("failBatch 成功但重派 spawn 抛错 → 报文为「已落库 + 重派异常」，不出现「滞留 running」", async () => {
    const script: ScriptEntry[] = [
      insertBatchEntry(1, "批次 1：探索 A 模块"),
      { kind: "tool", toolName: "task_advance_stage", args: { stageSeq: 1 } },
      spawnEntry(BRIEF_1),
      dispatchEntry(0, 2),
      { kind: "reply", text: "已派发。" },
      { kind: "reply", text: "收到收口通知。" },
      { kind: "reply", text: "（后续回合）" },
    ];
    let spawnCalls = 0;
    await withOrchestratorEnv(
      {
        script,
        // 首次 spawn 正常（批次接线），其后（重派）抛错——复现 failBatch 成功后的重派异常
        rawSpawn: (sessionId, task) => {
          spawnCalls += 1;
          if (spawnCalls > 1) throw new Error("重派 spawn 失败（注入）");
          return { status: "run", agentId: "agent-initial-1" };
        },
      },
      async (env) => {
        const { jobId } = await env.engine.createTask({
          type: "fake-task",
          projects: ["demo"],
          params: { projectRoot: "/tmp/demo" },
          createdBy: "page",
        });
        // 首个驱动回合：插行 + spawn + dispatch → 批次 running
        await env.until(() => env.store.getBatches(jobId, 1).length === 1);
        const batch = env.store.getBatches(jobId, 1)[0]!;
        await env.until(() => env.store.getBatches(jobId, 1)[0]?.instanceId !== null);
        expect(batch.status).toBe("running");

        // 实例失败收口：failBatch 成功 → 重派 spawn 抛错 → 外层 catch
        const agentId = env.store.getBatches(jobId, 1)[0]!.instanceId!;
        await settleInstance(env, agentId, { closure: "failed", summary: "批次执行中断（注入）" });

        // 行状态事实：批次已 failed（不是 running）
        await env.until(() => env.store.getBatches(jobId, 1)[0]?.status === "failed");
        // 报文事实：终态短路报文即时出现（修复前需等 5s 退避重试后才会出「滞留 running」谎报）
        await env.until(() => env.orchestratorLog.some((l) => l.includes("收口后续环节异常")), 3000);
        // 不谎报「滞留 running，需人工介入」（修复前该文案在此路径出现）
        expect(env.orchestratorLog.some((l) => l.includes("批次滞留 running"))).toBe(false);
        // 不无意义地退避重试兜底 failBatch（终态行不可再转 failed）
        expect(env.orchestratorLog.some((l) => l.includes("5s 后兜底重试"))).toBe(false);
      },
    );
  });
});
