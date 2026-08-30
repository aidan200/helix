import { describe, expect, test } from "bun:test";
import { MAX_BATCH_RETRY, nextRetryCount, shouldRetryBatch } from "../../src/domain/task/retry";

/**
 * CL-2-T5 纯逻辑部分（U 半）：自动重试有界次数判定——
 * O-3 裁决：MAX_BATCH_RETRY=3 收口常量；retryCount 如实递增；
 * 超限上浮（batch→stage/job failed）属编排/引擎行为，不在 domain（T1.3/T2.2）。
 */

describe("自动重试判定（CL-2-T5 纯逻辑）", () => {
  test("MAX_BATCH_RETRY = 3（O-3 裁决值）", () => {
    expect(MAX_BATCH_RETRY).toBe(3);
  });

  test("retryCount 0/1/2 → 可重试；3 及以上 → false", () => {
    expect(shouldRetryBatch(0)).toBe(true);
    expect(shouldRetryBatch(1)).toBe(true);
    expect(shouldRetryBatch(2)).toBe(true);
    expect(shouldRetryBatch(3)).toBe(false);
    expect(shouldRetryBatch(4)).toBe(false);
  });

  test("nextRetryCount 递增语义", () => {
    expect(nextRetryCount(0)).toBe(1);
    expect(nextRetryCount(2)).toBe(3);
    // 如实递增序列：0→1→2→3（第 3 次后不再重试）
    let retryCount = 0;
    for (let i = 1; i <= 3; i++) {
      retryCount = nextRetryCount(retryCount);
      expect(retryCount).toBe(i);
    }
    expect(shouldRetryBatch(retryCount)).toBe(false);
  });
});
