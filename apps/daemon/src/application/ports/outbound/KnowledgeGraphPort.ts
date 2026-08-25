import type {
  AnchorDeclRow,
  AttachmentSnapshot,
  IndexStatus,
  NodeDetail,
  NodeDigestRow,
  SyncBaselineView,
} from "../../../domain/kg/types";

export type { AnchorDeclRow, AttachmentSnapshot, IndexStatus, NodeDetail, NodeDigestRow, SyncBaselineView };

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

  /** 节点详情聚合（锚声明/物化锚/出入边/supersede 链/变更日志）；不存在返回 null。 */
  getNode(projectRoot: string, id: string): NodeDetail | null;

  /** 索引状态：导入基准戳（meta）/符号计数/degraded 标记位（F5.5 上报数据源）。 */
  getIndexStatus(projectRoot: string): IndexStatus;

  /**
   * sync 管道基准读面（T2.2 消费）：上一基准 files/symbols + 活跃物化锚
   * + 锚声明全集——增量跳过判定 / 符号消亡 diff / 物化全量重算差集输入。
   */
  getSyncBaseline(projectRoot: string): SyncBaselineView;
}
