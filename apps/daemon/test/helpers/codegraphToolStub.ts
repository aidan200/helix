import type { CodegraphToolDeps } from "../../src/adapters/driven/tools/codegraph/CodegraphTool";

/**
 * codegraph 工具装配替身（W1-B，与 kgToolsStub 同款纪律）：profile 全集
 * 声明 codegraph 后，凡解析 MainSessionProfile/SubAgentProfile 工具集的
 * executor 均需注入 codegraph 面（缺注入即 resolveTools fail-fast）。
 * 本替身零 CLI 零 IO：runQuery 恒返回空 JSON 文本，indexExists 恒 true
 *（装配测试不触执行路径）。
 */
export function codegraphToolStub(workspaceRoot: string): CodegraphToolDeps {
  return {
    engine: {
      runQuery: async () => "{}",
    },
    workspaceRoot,
    indexExists: () => true,
  };
}
