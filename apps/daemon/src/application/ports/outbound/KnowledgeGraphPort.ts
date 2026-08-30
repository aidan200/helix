import type {
  AnchorDeclRow,
  AnchorReverseHit,
  AttachmentSnapshot,
  CandidateStatusCounts,
  ChangeLogEntry,
  IndexStatus,
  NodeDetail,
  NodeDigestRow,
  SyncBaselineView,
  VerifyView,
} from "../../../domain/kg/types";

export type {
  AnchorDeclRow,
  AnchorReverseHit,
  AttachmentSnapshot,
  ChangeLogEntry,
  IndexStatus,
  NodeDetail,
  NodeDigestRow,
  SyncBaselineView,
  VerifyView,
};

/**
 * .kg 知识图谱读出口端口（outbound，architecture.md §3.3）。
 *
 * 读写分离（附着只读面复用）：附着管线（T1.2）与任务层注入共用
 * getAttachmentSnapshot；工具面 search/get（T3.3）走同一读口；页面
 * （CL-5）读走 WAL 不阻塞写。真实实现在 adapters/driven/sqlite-kg；
 * 本文件只有接口/类型定义（AG-01）。
 */
export interface KnowledgeGraphPort {
  /** 附着快照：物化锚 join 节点摘要（superseded 不进快照）；附着与注入共用。 */
  getAttachmentSnapshot(projectRoot: string): AttachmentSnapshot;

  /** search：name/digest LIKE 子串命中，按 id 确定性排序（重名多行靠 digest 区分）。 */
  search(projectRoot: string, q: string): readonly NodeDigestRow[];

  /**
   * 锚反查（R20 affected op 数据面）：target（相对路径 / 符号名 / path#symbol
   * 复合形态）→ materialized_anchors 反查管辖节点摘要（orphan=0 且非
   *   superseded；失效即静默与附着快照同纪律）；物化零命中的节点退查
   *   anchor_decl 声明（viaDecl=true——锚未物化/索引未建的兑底面；glob
   *   pattern 只做精确与 path/symbol 段匹配，不做 glob 展开）。
   */
  reverseAnchorLookup(projectRoot: string, target: string): readonly AnchorReverseHit[];

  /** 节点详情聚合（锚声明/物化锚/出入边/supersede 链/变更日志）；不存在返回 null。 */
  getNode(projectRoot: string, id: string): NodeDetail | null;

  /** 索引状态：导入基准戳（meta）/符号计数/degraded 标记位（F5.5 上报数据源）。 */
  getIndexStatus(projectRoot: string): IndexStatus;

  /**
   * sync 管道基准读面（T2.2 消费）：上一基准 files/symbols + 活跃物化锚
   * + 锚声明全集——增量跳过判定 / 符号消亡 diff / 物化全量重算差集输入。
   */
  getSyncBaseline(projectRoot: string): SyncBaselineView;

  /**
   * 验证期检查读面（T5.1 消费）：全节点/全边（原始行）/全物化锚（含
   * orphan 标记）/锚声明全集/文件面（mtime=churn 证据）——三检查与
   * 变化报告的共同数据源。只读，零写路径（AD-6 只列不修）。
   */
  getVerifyView(projectRoot: string): VerifyView;

  /**
   * 变更日志按迭代过滤（T5.1 变化报告 knowledge_change 数据源；
   * seq 正序）。
   */
  getChangeLog(projectRoot: string, iterationId: string): readonly ChangeLogEntry[];

  /**
   * 知识节点计数（kg.list total 数据源：过滤前全集，含 superseded 留史行）。
   * 仅在 .kg 已存在的项目上调用（调用方先行 hasIndex 判定，读面绝不新建
   * 库文件）。
   */
  countNodes(projectRoot: string): number;

  /**
   * 非 superseded 节点计数（T3.2，contracts/kg-bootstrap-api.md §1）：
   * bootstrap 准入「知识层为空」机械定义 + kg.projects nodeCount 口径——
   * 已被取代的留史行不计入（「知识层为空」= 无现行知识，非无任何行）。
   */
  countActiveNodes(projectRoot: string): number;

  /**
   * 非 superseded 且带 layer 的产出节点计数（O-9 准入闸精化）：bootstrap
   * 准入「知识层为空」精化口径——只有带 layer 的产出（bootstrap 三阶段落账
   * 形态）才算图谱已有产出；sediment 沉淀节点（layer 为 NULL，任务闭环
   * 沉淀产生）不计入、不阻挡 bootstrap 入口。
   */
  countActiveLayeredNodes(projectRoot: string): number;

  /**
   * 按产出批次反查节点 id 集（T2.2 F2.7 阶段产物聚合）：nodes.origin_batch
   * 元数据 ∈ batchIds，排除 superseded；id 升序确定性。只读零写路径。
   */
  listNodeIdsByOriginBatches(projectRoot: string, batchIds: readonly string[]): readonly string[];

  /**
   * 库内最近一次变更所属迭代 id（T5.3 kg.change.report 缺省入参 = 当前
   * 迭代的确定性推导；change_log 空 → null）。仅在 .kg 已存在的项目上调用。
   */
  latestIteration(projectRoot: string): string | null;

  /**
   * candidates 台账四态计数（W2-E kg.health 体检看板数据源：candidates 表
   * 按 status 聚合，缺态 = 0）。仅在 .kg 已存在的项目上调用（调用方先行
   * hasIndex 判定，读面绝不新建库文件）。
   */
  countCandidatesByStatus(projectRoot: string): CandidateStatusCounts;
}
