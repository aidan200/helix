/**
 * risk 三级确认闸单测（M2 批，设计 D3——risk 挂动作不挂宿主）：
 * - read 免确认直行（direct）；
 * - write 走 steward.confirmations 两段式（confirm-required：propose→用户
 *   确认→执行）；
 * - destructive 强制确认且**不可豁免**——【突变验证】任何豁免路径（exempt
 *   / auto_confirm 类旗标）必须整单被拒（reject），不得静默降级为直行或
 *   绕过确认闸。
 */
import { describe, expect, test } from "bun:test";
import { evaluateSurfaceRisk, surfaceRiskRank } from "../../src/application/surface/SurfaceRiskGate";

describe("evaluateSurfaceRisk：三档闸门（D3）", () => {
  test("read 免确认直行", () => {
    expect(evaluateSurfaceRisk("read")).toEqual({ outcome: "direct" });
  });

  test("write 走确认闸两段式（未确认不执行——confirm-required）", () => {
    expect(evaluateSurfaceRisk("write")).toEqual({ outcome: "confirm-required" });
  });

  test("destructive 强制确认（confirm-required——不可直行）", () => {
    expect(evaluateSurfaceRisk("destructive")).toEqual({ outcome: "confirm-required" });
  });
});

describe("evaluateSurfaceRisk：豁免路径必须失败（突变验证——D3 不可豁免）", () => {
  test("【突变】destructive + 豁免旗标 → reject（不放行、不降级）", () => {
    const decision = evaluateSurfaceRisk("destructive", { exempt: true });
    expect(decision.outcome).toBe("reject");
    if (decision.outcome === "reject") {
      expect(decision.reason).toContain("destructive");
    }
  });

  test("【突变】write + 豁免旗标 → reject（M2 无豁免面——write 未确认恒不执行）", () => {
    expect(evaluateSurfaceRisk("write", { exempt: true }).outcome).toBe("reject");
  });

  test("read 不受豁免旗标影响（免确认是 read 语义本身，非豁免）", () => {
    expect(evaluateSurfaceRisk("read", { exempt: true })).toEqual({ outcome: "direct" });
  });
});

describe("surfaceRiskRank：risk 挂动作用档序（降级判定用）", () => {
  test("read < write <destructive", () => {
    expect(surfaceRiskRank("read")).toBeLessThan(surfaceRiskRank("write"));
    expect(surfaceRiskRank("write")).toBeLessThan(surfaceRiskRank("destructive"));
  });
});
