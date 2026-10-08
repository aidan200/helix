import type { MemorySearchToolDeps } from "../../src/adapters/driven/tools/memory-search/MemorySearchTool";

/**
 * memory_search 装配替身（批E）：MainSessionProfile/SubAgentProfile 声明
 * memory_search 后，凡解析 main/worker 工具集的 executor 均需注入 memorySearch
 * 面（条件注册纪律——缺注入即 resolveTools fail-fast，声明=注册铁律）。
 * 本替身零库零 IO：记忆恒不可用、检索恒空、无项目上下文。
 */
export function memorySearchStub(): MemorySearchToolDeps {
  return {
    service: {
      isAvailable: () => false,
      searchMemories: async () => [],
    },
    projectOf: () => undefined,
  };
}
