import { describe, expect, test } from "bun:test";
import {
  BATCH_STATUSES,
  JOB_STATUSES,
  STAGE_STATUSES,
  WORK_ITEM_STATUSES,
} from "../../src/domain/task/types";

/**
 * CL-2-T2 / AD-5 机械断言：四枚举值扁平化后 grep 无 /review|awaiting|confirm/i——
 * 无中途人审态（执行全程无 gate，确认只在开启前一次）；语义词只允许出现在
 * manifest 的开启前 confirm 字段，不允许出现在任何状态值里。
 */

describe("无 review 语义（AD-5 机械断言，CL-2-T2）", () => {
  test("四枚举值扁平化无 /review|awaiting|confirm/i", () => {
    const all = [...JOB_STATUSES, ...STAGE_STATUSES, ...BATCH_STATUSES, ...WORK_ITEM_STATUSES];
    expect(all.length).toBeGreaterThan(0);
    for (const value of all) {
      expect(value).not.toMatch(/review|awaiting|confirm/i);
    }
  });

  test("状态值集合与 §3.2/§3.3 契约一致（无重复、口径锁定）", () => {
    expect([...JOB_STATUSES]).toEqual(["pending", "running", "paused", "done", "failed", "cancelled"]);
    expect([...STAGE_STATUSES]).toEqual(["pending", "running", "done", "failed"]);
    expect([...BATCH_STATUSES]).toEqual(["pending", "running", "done", "failed"]);
    expect([...WORK_ITEM_STATUSES]).toEqual(["pending", "in_progress", "done", "abandoned"]);
  });
});
