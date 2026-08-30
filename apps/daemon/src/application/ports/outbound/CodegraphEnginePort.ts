import type { EngineUnavailableInfo, IndexFreshness, SymbolSet } from "../../../domain/kg/types";

export type { EngineUnavailableInfo, IndexFreshness, SymbolSet };

/**
 * codegraph 引擎被动封装出口端口（outbound，architecture.md §3.3）。
 *
 * AF-2 裁决（iter-20260825-11fo）：引擎是外部降位抽取器（AD-8/AD-15）——
 * - ensureIndex：CLI 一次性被动命令构建/新鲜度判定（status -j 探测 +
 *   init/index 全量或 sync 增量）；适配器代码层不提供 serve/daemon/watch
 *   等长驻调用面；
 * - exportSymbols：只读直连 `<projectRoot>/.codegraph/codegraph.db`
 *   （mode=ro 系只读连接），投影 symbols（nodes 含 span）/contains
 *   （edges kind='contains'）/files（基准面）三面——与 CLI 二进制解耦。
 *
 * degraded 三入口（二进制不可达/schema 版本超限或缺表/子进程失败或超时）
 * 统一抛 EngineUnavailable（kind 鸭子判别）；空 SymbolSet = 空索引合法态，
 * 与 degraded 语义显式区分。真实实现在 adapters/driven/codegraph-engine，
 * 测试基建 CodegraphEngineFake（test/mocks）。本文件只有接口/类型定义（AG-01）。
 *
 * W1-B（R5/R6）：runQuery 只读查询面——agent 工具 codegraph 的引擎出口
 * （status/search/node/callers/callees/impact 六 op，**无 explore**，零写类
 * 子命令）。同样一次性 CLI 即起即退；索引缺失短路在工具层（同
 * KgProjectService absent 先例——读面绝不触发建索引）。
 */

/**
 * 只读查询请求（W1-B，R6 六 op 判别联合）。CLI 子命令/旗标映射归适配器
 * （application/tool 层零 CLI 知识）；op 与 v1 codegraph 工具面语义对齐。
 */
export type CodegraphQueryRequest =
  | { readonly op: "status" }
  | { readonly op: "search"; readonly pattern: string; readonly kind?: string; readonly limit?: number }
  | {
      readonly op: "node";
      readonly symbol?: string;
      readonly file?: string;
      readonly offset?: number;
      readonly limit?: number;
      readonly symbolsOnly?: boolean;
    }
  | { readonly op: "callers"; readonly symbol: string; readonly limit?: number }
  | { readonly op: "callees"; readonly symbol: string; readonly limit?: number }
  | { readonly op: "impact"; readonly symbol: string; readonly depth?: number };

export interface CodegraphEnginePort {
  /**
   * 被动构建/新鲜度判定：status 探测 → 未初始化 init（全量首建）；
   * 已初始化新鲜 sync（增量）；索引截断/推荐重建 index（全量重建）。
   * 每次调用即起即退（spawn 子进程跑完收集退出码/输出，无长驻进程）。
   * 引擎不可用/失败/超时 → 抛 EngineUnavailable。
   */
  ensureIndex(projectRoot: string): Promise<IndexFreshness>;

  /**
   * 只读符号投影（绝不写 codegraph.db；零 DML/DDL/写类 PRAGMA）：
   * symbols+span ← nodes、contains ← edges、文件基准面 ← files。
   * 库缺失/schema 版本高于已测上限/缺表 → 抛 EngineUnavailable。
   */
  exportSymbols(projectRoot: string): Promise<SymbolSet>;

  /**
   * 删除项目索引目录（kg.index.delete 消费，C1）：`<projectRoot>/.codegraph`
   * 整目录递归删除，幂等（不存在 = no-op）。纯文件系统操作（被动模式无
   * CLI delete 面）；kg 侧索引态复位与 watcher 联动由调用方编排。
   */
  deleteIndex(projectRoot: string): Promise<void>;

  /**
   * 只读查询（W1-B，R5/R6）：六 op 一次性 CLI 调用，返回 stdout 文本
   *（适配器负责超时与输出截断）。引擎不可用/失败/超时 → 抛
   * EngineUnavailable。**无任何写面子命令**（init/index/sync 只走
   * ensureIndex 构建路由；本面不触发任何建索引动作）。
   */
  runQuery(projectRoot: string, request: CodegraphQueryRequest): Promise<string>;
}
