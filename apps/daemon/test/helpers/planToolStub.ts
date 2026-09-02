import type { PlanToolDeps } from "../../src/adapters/driven/tools/plan/PlanTools";

/**
 * plan 三工具装配替身（main-session plan 批）：MainSessionProfile 声明 plan
 * 三名后，凡解析 main 工具集的 executor 均需注入 plan 面（条件注册纪律——
 * 缺注入即 resolveTools fail-fast）。本替身零库零 IO：service 恒空台账 /
 * 恒成功；instanceId 固定 "main-stub"（替身可辨认来源）。
 */
export function planToolStub(): PlanToolDeps {
  return {
    service: {
      async createPlan(_instanceId, items) {
        return { created: items.length, rebuilt: false };
      },
      async updateItem() {},
      getPlan: () => [],
      async forceResolveInProgress() {
        return { resolved: 0 };
      },
    },
    instanceId: "main-stub",
  };
}
