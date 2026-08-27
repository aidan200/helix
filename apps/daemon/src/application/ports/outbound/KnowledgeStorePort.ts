import type { KnowledgeWriteOp, SymbolBatch, WriteResult } from "../../../domain/kg/types";

export type { KnowledgeWriteOp, SymbolBatch, WriteResult };

/**
 * .kg 知识库写出口端口（outbound，architecture.md §3.3）。
 *
 * 两个写者按表分域、互不竞争（AD-15 定论）：
 * - writeKnowledge：知识层四表，唯一写入口——schema 已在 KgWriteService
 *   校验（AD-9 校验即防线），本 port 只做事务内引用完整性（存在性/冲突/状态机）；
 * - applySync：sync 管道单事务（符号层三表+物化锚+meta 基准戳，T2.2 消费），
 *   与知识层写不同表集，同库文件、各自连接+事务，WAL 保证并发。
 *
 * 真实实现在 adapters/driven/sqlite-kg（<projectRoot>/.helix-kg/kg.db per-project
 * 连接）；单测用内存假实现。本文件只有接口/类型定义（AG-01）。
 */
export interface KnowledgeStorePort {
  /**
   * sync 单事务落库：files/symbols/contains_edges 三表 upsert + 物化锚 +
   * meta（导入基准戳与 degraded 标记）。中途故障抛出（调用方 KgSyncService
   * 处置），不落半态。
   */
  applySync(projectRoot: string, batch: SymbolBatch): Promise<void>;

  /**
   * 知识层写（nodes/anchor_decl/change_log/edges，单 op 单事务）：
   * change_log 自动追加（迭代 id/op/nodeId/supersede_of）；编号事务内分配
   * （只增不减永不复用，AD-16）。预期失败（引用不存在/冲突/状态机非法/
   * 校验未覆盖的落库故障）返回结构化错误，事务回滚零写入。
   */
  writeKnowledge(projectRoot: string, op: KnowledgeWriteOp): WriteResult;
}
