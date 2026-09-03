import { describe, expect, test } from "bun:test";
import {
  assertBatchTransition,
  assertJobTransition,
  canTransitionBatch,
  canTransitionJob,
  canTransitionStage,
  assertStageTransition,
  isTerminalBatch,
  isTerminalJob,
  isTerminalStage,
} from "../../src/domain/task/job";
import { BATCH_STATUSES, JOB_STATUSES, STAGE_STATUSES } from "../../src/domain/task/types";
import { DomainError } from "../../src/domain/DomainError";

/**
 * CL-2-T2（U 半）：状态机通用零语义——
 * ① job 全合法迁移通过 + 全非法组合拒绝（笛卡尔积，§3.3 迁移图）；
 * ② 非法迁移 assertJobTransition 抛 DomainError 且 message 含 from→to；
 * ③ 终态判定（job 终态三值 done/failed/cancelled）；
 * ④ stage/batch 迁移集合 = pending→running→done/failed。
 */

/** §3.3 job 状态机全部合法迁移（pending→running/cancelled；running→paused/done/failed/cancelled；paused→running/cancelled）。 */
const LEGAL_JOB: ReadonlySet<string> = new Set([
  "pending->running",
  "pending->cancelled",
  "running->paused",
  "running->done",
  "running->failed",
  "running->cancelled",
  "paused->running",
  "paused->cancelled",
]);

/** stage 状态机全部合法迁移（pending→running；running→done/failed）。 */
const LEGAL_STAGE: ReadonlySet<string> = new Set([
  "pending->running",
  "running->done",
  "running->failed",
]);

/**
 * batch 状态机全部合法迁移（AF-1.3 增补 2026-08-29：failed→running 自动重派路径，
 * architecture §3.3「failed 由自动重试接管」/§4.5 设计内语义；job/stage 不动）。
 */
const LEGAL_BATCH: ReadonlySet<string> = new Set([
  "pending->running",
  "running->done",
  "running->failed",
  "failed->running",
]);

describe("job 状态机（CL-2-T2 ①②③）", () => {
  test("全合法迁移 canTransitionJob 通过、assertJobTransition 不抛", () => {
    for (const edge of LEGAL_JOB) {
      const [from, to] = edge.split("->") as [string, string];
      expect(canTransitionJob(from as never, to as never)).toBe(true);
      expect(() => assertJobTransition(from as never, to as never)).not.toThrow();
    }
  });

  test("笛卡尔积全非法组合拒绝（pending→done、paused→done、done→任意、cancelled→任意、自迁移…）", () => {
    for (const from of JOB_STATUSES) {
      for (const to of JOB_STATUSES) {
        const legal = LEGAL_JOB.has(`${from}->${to}`);
        expect(canTransitionJob(from, to)).toBe(legal);
        if (!legal) {
          expect(() => assertJobTransition(from, to)).toThrow(DomainError);
        }
      }
    }
  });

  test("非法迁移 message 含 from→to", () => {
    expect(() => assertJobTransition("paused", "done")).toThrow(/paused→done/);
    expect(() => assertJobTransition("pending", "done")).toThrow(/pending→done/);
    expect(() => assertJobTransition("done", "running")).toThrow(/done→running/);
  });

  test("终态判定：done/failed/cancelled 为终态，pending/running/paused 非终态", () => {
    for (const status of JOB_STATUSES) {
      const expected = status === "done" || status === "failed" || status === "cancelled";
      expect(isTerminalJob(status)).toBe(expected);
    }
  });
});

describe("stage/batch 状态机（CL-2-T2 ④）", () => {
  test("stage：合法迁移通过，笛卡尔积非法组合拒绝", () => {
    for (const from of STAGE_STATUSES) {
      for (const to of STAGE_STATUSES) {
        const legal = LEGAL_STAGE.has(`${from}->${to}`);
        expect(canTransitionStage(from, to)).toBe(legal);
        if (!legal) {
          expect(() => assertStageTransition(from, to)).toThrow(DomainError);
        }
      }
    }
  });

  test("batch：合法迁移通过（含 AF-1.3 failed→running 自动重派），笛卡尔积非法组合拒绝", () => {
    for (const from of BATCH_STATUSES) {
      for (const to of BATCH_STATUSES) {
        const legal = LEGAL_BATCH.has(`${from}->${to}`);
        expect(canTransitionBatch(from, to)).toBe(legal);
        if (!legal) {
          expect(() => assertBatchTransition(from, to)).toThrow(DomainError);
        }
      }
    }
  });

  test("batch 重派迁移 message 含 from→to（failed→done 等非法组合仍拒绝）", () => {
    expect(() => assertBatchTransition("failed", "done")).toThrow(/failed→done/);
    expect(() => assertBatchTransition("failed", "failed")).toThrow(/failed→failed/);
    expect(() => assertBatchTransition("done", "running")).toThrow(/done→running/);
  });

  test("终态判定：stage done/failed 终态；batch 仅 done 终态（failed 可重入，AF-1.3）", () => {
    for (const status of STAGE_STATUSES) {
      expect(isTerminalStage(status)).toBe(status === "done" || status === "failed");
    }
    for (const status of BATCH_STATUSES) {
      // failed 对 batch 非终态：自动重派路径可将其带回 running（§4.5）。
      expect(isTerminalBatch(status)).toBe(status === "done");
    }
  });
});
