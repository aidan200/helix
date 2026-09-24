import type { TodoToolDeps } from "../../src/adapters/driven/tools/todo/TodoTools";

/**
 * todo 双工具装配替身（plan 三工具改名批）：MainSessionProfile 声明 todo
 * 两名后，凡解析 main 工具集的 executor 均需注入 todo 面（条件注册纪律——
 * 缺注入即 resolveTools fail-fast）。本替身零库零 IO：service 恒空清单 /
 * 恒成功；instanceId 固定 "main-stub"（替身可辨认来源）。
 */
export function planToolStub(): TodoToolDeps {
  return {
    service: {
      async writeTodos(_instanceId, items) {
        return { written: items.length };
      },
      getPlan: () => [],
      async forceResolveInProgress() {
        return { resolved: 0 };
      },
    },
    instanceId: "main-stub",
  };
}
