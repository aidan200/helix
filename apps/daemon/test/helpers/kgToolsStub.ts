import type { KgToolOptions } from "../../src/adapters/driven/tools/CoreToolExecutor";

/**
 * kg 双工具装配替身（T3.3）：profile 全集声明 kg/kg-update 后，凡解析
 * MainSessionProfile/SubAgentProfile 工具集的 executor 均需注入 kg 面
 * （browser/orchestration 条件注册同款纪律——缺注入即 resolveTools
 * fail-fast）。本替身零库零 IO：search/locate 恒空、write 恒拒。
 */
export function kgToolsStub(workspaceRoot: string): KgToolOptions {
  return {
    query: {
      search: () => [],
      get: () => null,
      locate: () => [],
    },
    write: {
      write: () => ({
        ok: false,
        error: { code: "KG_E_SCHEMA", message: "kg 双工具测试替身：未接真库" },
      }),
    },
    workspaceRoot,
    scanProjects: () => [],
  };
}
