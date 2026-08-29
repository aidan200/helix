/**
 * 自动重试判定纯逻辑（architecture.md §4.5，O-3 裁决：有界次数 + 如实呈现）。
 * 超限上浮（batch failed → stage/job failed）属编排/引擎行为，不在 domain（T1.3/T2.2）。
 */

/** 批次自动重试上限（O-3 裁决值，常量收口）。 */
export const MAX_BATCH_RETRY = 3;

/** 是否仍可自动重试：retryCount < MAX_BATCH_RETRY。 */
export function shouldRetryBatch(retryCount: number): boolean {
  return retryCount < MAX_BATCH_RETRY;
}

/** retryCount 递增语义（页面如实呈现，F3.3）。 */
export function nextRetryCount(retryCount: number): number {
  return retryCount + 1;
}
