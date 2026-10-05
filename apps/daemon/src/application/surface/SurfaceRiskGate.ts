/**
 * SurfaceRiskGate —— risk 三级确认闸判定面（M2 批；设计 D3「risk 挂动作，
 * 不挂宿主」）。
 *
 * 判定纯函数（零 IO）——闸门执行体在消费面（StewardService 确认闸）：
 * - read：免确认直行（direct）——浏览态读操作；
 * - write：走既有 steward.confirmations 两段式（confirm-required：
 *   propose→用户确认→执行）；
 * - destructive：强制确认且**不可豁免**——任何豁免尝试（exempt 旗标）
 *   整单被拒（reject），不得静默降级为直行或绕过确认。
 *
 * 豁免位（exempt）语义：M2 无策略豁免面（隐私策略/域策略配置属 M4）——
 * write 同样拒绝豁免（未确认恒不执行）；destructive 的「不可豁免」是
 * D3 硬不变式（未来策略面也不得放行，测试钉死）。read 的免确认是 risk
 * 语义本身，不属豁免。
 */
import type { SurfaceRisk } from "@helix/protocol";

/** 闸门判定（三出口：直行 / 需确认 / 整单拒绝）。 */
export type SurfaceRiskDecision =
  | { readonly outcome: "direct" }
  | { readonly outcome: "confirm-required" }
  | { readonly outcome: "reject"; readonly reason: string };

/** 豁免旗标视图（豁免尝试输入——判定面只看位不看来源）。 */
export interface SurfaceRiskGateOptions {
  /** 豁免尝试位（策略/调用方自声明「免确认」——M2 恒不放行，见文件头）。 */
  readonly exempt?: boolean;
}

/** risk 档序（read 1 < write 2 < destructive 3——降档判定基准）。 */
export function surfaceRiskRank(risk: SurfaceRisk): number {
  return risk === "read" ? 1 : risk === "write" ? 2 : 3;
}

/** 三级闸判定（D3）。 */
export function evaluateSurfaceRisk(risk: SurfaceRisk, opts?: SurfaceRiskGateOptions): SurfaceRiskDecision {
  if (risk === "read") return { outcome: "direct" }; // 免确认是 read 语义，非豁免
  if (opts?.exempt === true) {
    // 【突变验证钉子】豁免路径必须失败——write 无豁免面、destructive 不可豁免
    return {
      outcome: "reject",
      reason:
        risk === "destructive"
          ? "destructive 动作确认闸不可豁免（D3 硬不变式）——豁免请求整单拒绝，必须用户确认后执行"
          : "write 动作未确认不可执行；M2 无豁免面（策略豁免属 M4）——豁免请求整单拒绝",
    };
  }
  return { outcome: "confirm-required" };
}
