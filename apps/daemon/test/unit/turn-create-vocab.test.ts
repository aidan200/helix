/**
 * code-review M：Turn.create 重建路径状态词表断言。
 * 缺陷现场：Session.restoreFrom（Session.ts:364）以快照数据直调 Turn.create，
 * 脏行 status 静默进聚合——后续迁移（markToolRunning/completeTurn 等 expect
 * 守卫）恒抛且定位困难；对照 AgentInstance.restore（INSTANCE_STATES 断言）
 * 与 ToolCallRecord.restore 均有态集断言先例，Turn 缺位。
 */
import { describe, expect, test } from "bun:test";
import { Turn, type TurnStatus } from "../../src/domain/session/Turn";
import { DomainError } from "../../src/domain/DomainError";

const T0 = new Date(0).toISOString();
const base = { id: "t1", inputEntryId: "e1", startedAt: T0, endedAt: null };

describe("code-review M：Turn.create 状态词表断言（重建 fail-fast）", () => {
  test("脏行 status → DomainError（不静默进聚合）", () => {
    // 现行行为红：词表外 status 静默通过，迁移时才爆（定位困难）
    expect(() => Turn.create({ ...base, status: "garbage" as TurnStatus })).toThrow(DomainError);
  });

  test("四值合法集照常重建（回归面）", () => {
    for (const status of ["generating", "toolRunning", "completed", "interrupted"] as const) {
      expect(() => Turn.create({ ...base, status })).not.toThrow();
    }
  });
});
