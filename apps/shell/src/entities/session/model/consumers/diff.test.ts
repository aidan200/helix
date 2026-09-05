// @vitest-environment node
/**
 * diff 消费者族测试（T3+T4 diff 批）。
 *
 * 钉纪律：
 * - diff.changed（publishDelta 瞬态通道广播帧）→ state.diff 切片；
 * - phase 三态映射：cleared → null（开轮清零、chip 隐藏）；active/frozen →
 *   载荷整体落切片（frozen 由 CSS 层灰态呈现，store 不改形）；
 * - 全量帧整体替换（幂等；乱序/重复安全——plan 族同规）；
 * - 非 diff.changed 帧零状态变更（default 原状态返回）。
 */
import { describe, expect, it } from "vitest";
import { applyDiffEvent, DIFF_EVENT_TYPES } from "./diff";
import { createInitialSessionState } from "../state";
import type { EventEnvelope } from "@helix/protocol";
import type { DiffChangedPayload } from "@helix/protocol";

function frame(payload: DiffChangedPayload): EventEnvelope {
  return { v: 0, type: "diff.changed", sessionId: "s1", payload } as unknown as EventEnvelope;
}

describe("DIFF_EVENT_TYPES 注册面", () => {
  it("只承接 diff.changed", () => {
    expect([...DIFF_EVENT_TYPES]).toEqual(["diff.changed"]);
  });
});

describe("applyDiffEvent 三态映射", () => {
  it("cleared → diff = null（开轮清零：chip 隐藏、下轮重计）", () => {
    const s0 = { ...createInitialSessionState(), diff: { turnId: "t-1", phase: "frozen" as const, adds: 12, dels: 4, fileCount: 3 } };
    const s1 = applyDiffEvent(s0, frame({ turnId: "t-2", phase: "cleared", adds: 0, dels: 0, fileCount: 0 }));
    expect(s1.diff).toBeNull();
  });

  it("active → 载荷整体落切片（累计即时视图）", () => {
    const s1 = applyDiffEvent(createInitialSessionState(), frame({ turnId: "t-1", phase: "active", adds: 12, dels: 4, fileCount: 3 }));
    expect(s1.diff).toEqual({ turnId: "t-1", phase: "active", adds: 12, dels: 4, fileCount: 3 });
  });

  it("frozen → 终值定格（灰态呈现归 CSS，store 形状同 active）", () => {
    const s1 = applyDiffEvent(createInitialSessionState(), frame({ turnId: "t-1", phase: "frozen", adds: 30, dels: 8, fileCount: 5 }));
    expect(s1.diff).toMatchObject({ phase: "frozen", adds: 30, dels: 8 });
  });

  it("全量帧整体替换（幂等：重复帧同值安全）", () => {
    const s1 = applyDiffEvent(createInitialSessionState(), frame({ turnId: "t-1", phase: "active", adds: 5, dels: 1, fileCount: 1 }));
    const s2 = applyDiffEvent(s1, frame({ turnId: "t-1", phase: "active", adds: 5, dels: 1, fileCount: 1 }));
    expect(s2.diff).toEqual(s1.diff);
    // 原状态不可变（纯函数纪律 AG-14）
    expect(s1).not.toBe(s2);
  });

  it("非 diff.changed 帧 → 原状态引用返回（default 语义）", () => {
    const s0 = createInitialSessionState();
    const other = { v: 0, type: "session.plan.changed", payload: {} } as unknown as EventEnvelope;
    expect(applyDiffEvent(s0, other)).toBe(s0);
  });

  it("初始态 diff = null（daemon 内存态重启丢失 → 前端如实呈现无记录）", () => {
    expect(createInitialSessionState().diff).toBeNull();
  });
});
