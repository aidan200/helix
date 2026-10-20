/**
 * tasks-mock 台账语义测试（TR-155 mock 镜像对齐 / 回执输出隔离）。
 *
 * - task.retry 镜像 daemon TaskEngineService.retry：failed 阶段重开 running、
 *   failed 批次 retryCount 归零 + 留痕、残留 running 批次收口 failed，并伴发
 *   stage/job 两族 task.changed；
 * - task.detail 回执逐层隔离：改回执引用（stages/batches/plan/projects）不落
 *   mock 台账（单例跨用例串台防线）。
 */
import { describe, expect, it } from "vitest";
import type { EventEnvelope, TaskDetailDto } from "@helix/protocol";
import { TasksMockStore } from "./tasks-mock";

const asTask = (frames: EventEnvelope[]): TaskDetailDto =>
  (frames[0]!.payload as unknown as { task: TaskDetailDto }).task;

describe("tasks-mock 台账镜像（task 族）", () => {
  it("task.retry：failed 阶段重开 running + failed 批次 retryCount 归零留痕 + stage/job changed 帧", () => {
    const store = new TasksMockStore(); // 独立实例（模块级单例不串台）
    const frames = store.reply("task.retry", { jobId: "job-e55a" });
    expect(frames.map((f) => f.type)).toEqual(["task.retry.result", "task.changed", "task.changed"]);
    const detail = asTask(store.reply("task.detail", { jobId: "job-e55a" }));
    expect(detail.status).toBe("running");
    // 序④：failed 阶段重开（done/pending 不动）
    expect(detail.stages.map((s) => s.status)).toEqual(["running", "pending", "pending"]);
    // 序③：failed 批次预算归零 + 原次数与原 note 入新 note
    const failedBatch = detail.batches.find((b) => b.batchId === "batch-5b")!;
    expect(failedBatch.retryCount).toBe(0);
    expect(failedBatch.retryNote).toContain("此前失败 2 次");
    expect(failedBatch.retryNote).toContain("已达自动重试上限");
  });

  it("detail 回执逐层隔离：改回执引用不落台账（旧实现 stages/batches/plan 引用共享）", () => {
    const store = new TasksMockStore();
    const first = asTask(store.reply("task.detail", { jobId: "job-e55a" }));
    const stageBefore = first.stages[0]!.status;
    const retryBefore = first.batches[1]!.retryCount;
    // spec 侧就地改写回执（fidelity spec 常见动作）
    first.stages[0]!.status = "done";
    first.batches[1]!.retryCount = 99;
    first.projects.push("hacked");
    const again = asTask(store.reply("task.detail", { jobId: "job-e55a" }));
    expect(again.stages[0]!.status).toBe(stageBefore);
    expect(again.batches[1]!.retryCount).toBe(retryBefore);
    expect(again.projects).not.toContain("hacked");
  });
});
