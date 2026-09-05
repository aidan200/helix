// @vitest-environment node
/**
 * diff 消费者族测试（T3+T4 diff 批 + v0.3.1 §29 rehydrate 微批）。
 *
 * 钉纪律：
 * - diff.changed（publishDelta 瞬态通道广播帧）→ state.diff 切片；
 * - phase 映射（§29 后）：cleared → **忽略**（开轮不抹上一轮灰态显示——
 *   流式期 chip 不消失；首个 active 帧整体替换开新轮）；active/frozen →
 *   载荷整体落切片（frozen 由 CSS 层灰态呈现，store 不改形）；
 * - diff.get.result（§29 真消费）：回执摘要落切片（会话切回 rehydrate）
 *   ——轮次守卫：仅空态或同 turnId 时落，旧轮回执不降级覆盖新轮数据；
 * - 全量帧整体替换（幂等；乱序/重复安全——plan 族同规）；
 * - 非 diff 族帧零状态变更（default 原状态返回）。
 */
import { describe, expect, it } from "vitest";
import { applyDiffEvent, DIFF_EVENT_TYPES } from "./diff";
import { createInitialSessionState } from "../state";
import type { EventEnvelope } from "@helix/protocol";
import type { DiffChangedPayload } from "@helix/protocol";

function frame(payload: DiffChangedPayload): EventEnvelope {
  return { v: 0, type: "diff.changed", sessionId: "s1", payload } as unknown as EventEnvelope;
}

function resultFrame(turnId: string, adds: number, dels: number, files: number): EventEnvelope {
  return {
    v: 0,
    type: "diff.get.result",
    sessionId: "s1",
    payload: {
      files: Array.from({ length: files }, (_, i) => ({
        path: `/w/f${i}.txt`,
        status: "modified" as const,
        adds: 1,
        dels: 0,
        agents: ["main"],
      })),
      summary: { adds, dels },
      turnId,
      phase: "frozen" as const,
    },
  } as unknown as EventEnvelope;
}

describe("DIFF_EVENT_TYPES 注册面", () => {
  it("承接 diff.changed（广播）+ diff.get.result（§29 真消费）", () => {
    expect([...DIFF_EVENT_TYPES]).toEqual(["diff.changed", "diff.get.result"]);
  });
});

describe("applyDiffEvent 三态映射（diff.changed）", () => {
  it("cleared → 保留旧值（§29：开轮不抹上一轮灰态——流式期 chip 不消失）", () => {
    const s0 = { ...createInitialSessionState(), diff: { turnId: "t-1", phase: "frozen" as const, adds: 12, dels: 4, fileCount: 3 } };
    const s1 = applyDiffEvent(s0, frame({ turnId: "t-2", phase: "cleared", adds: 0, dels: 0, fileCount: 0 }));
    expect(s1.diff).toEqual(s0.diff); // 原样保留（显示权归首个 active 帧）
  });

  it("cleared 后首个 active 帧整体替换开新轮（轮切换由数据帧驱动）", () => {
    const s0 = { ...createInitialSessionState(), diff: { turnId: "t-1", phase: "frozen" as const, adds: 12, dels: 4, fileCount: 3 } };
    const cleared = applyDiffEvent(s0, frame({ turnId: "t-2", phase: "cleared", adds: 0, dels: 0, fileCount: 0 }));
    const s2 = applyDiffEvent(cleared, frame({ turnId: "t-2", phase: "active", adds: 3, dels: 1, fileCount: 1 }));
    expect(s2.diff).toEqual({ turnId: "t-2", phase: "active", adds: 3, dels: 1, fileCount: 1 });
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

  it("非 diff 族帧 → 原状态引用返回（default 语义）", () => {
    const s0 = createInitialSessionState();
    const other = { v: 0, type: "session.plan.changed", payload: {} } as unknown as EventEnvelope;
    expect(applyDiffEvent(s0, other)).toBe(s0);
  });

  it("初始态 diff = null（daemon 内存态重启丢失 → 前端如实呈现无记录）", () => {
    expect(createInitialSessionState().diff).toBeNull();
  });
});

describe("applyDiffEvent 回执真消费（diff.get.result；§29 rehydrate）", () => {
  it("空态回执 → 摘要落切片（会话切回 rehydrate：turnId/phase/adds/dels/fileCount）", () => {
    const s1 = applyDiffEvent(createInitialSessionState(), resultFrame("t-1", 12, 4, 3));
    expect(s1.diff).toEqual({ turnId: "t-1", phase: "frozen", adds: 12, dels: 4, fileCount: 3 });
  });

  it("轮次守卫：已有不同 turnId 数据时旧轮回执不降级覆盖（在途竞态防护）", () => {
    const s0 = { ...createInitialSessionState(), diff: { turnId: "t-2", phase: "active" as const, adds: 5, dels: 1, fileCount: 1 } };
    const s1 = applyDiffEvent(s0, resultFrame("t-1", 12, 4, 3));
    expect(s1).toBe(s0); // 原状态引用返回（守卫命中）
  });

  it("轮次守卫：同 turnId 回执原位刷新（幂等）", () => {
    const s0 = { ...createInitialSessionState(), diff: { turnId: "t-1", phase: "active" as const, adds: 5, dels: 1, fileCount: 1 } };
    const s1 = applyDiffEvent(s0, resultFrame("t-1", 12, 4, 3));
    expect(s1.diff).toEqual({ turnId: "t-1", phase: "frozen", adds: 12, dels: 4, fileCount: 3 });
  });
});
