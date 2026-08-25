import type { Database } from "bun:sqlite";
import type { KgDatabase } from "./KgDatabase";
import { META_KEYS } from "./schema";
import type {
  AnchorDeclaration,
  AnchorDeclRow,
  AnchorKind,
  AttachmentAnchor,
  AttachmentSnapshot,
  ChangeLogEntry,
  ContainsEdge,
  EdgeVerb,
  FileAnchor,
  IndexStatus,
  KnowledgeNode,
  MaterializedAnchor,
  NodeDetail,
  NodeDigestRow,
  NodeDomain,
  NodeEdgeView,
  NodeKind,
  NodeLayer,
  NodeStatus,
  RawEdgeRow,
  SupersedeChainLink,
  SymbolAnchor,
  SymbolFileRecord,
  SymbolRecord,
  SyncBaselineView,
  VerifyView,
} from "../../../domain/kg/types";

/**
 * SqliteKnowledgeGraph —— KnowledgeGraphPort 的 SQLite 实现（.kg 单库读面）。
 *
 * 只读 SELECT（AG-06 写点白名单不含本文件）；共用知识层通道连接（WAL 读
 * 不阻塞写）。supersede 链组装：change_log 的 supersede_of 边双向游走
 * （older=本节点 create 行 supersede_of / newer=他节点 create 行
 * supersede_of=本节点），环防护 + 步数上限。
 */
export interface SqliteKnowledgeGraphDeps {
  readonly database: KgDatabase;
}

/** 链游走步数上限（防御环/异常数据；正常链长个位数）。 */
const MAX_CHAIN_WALK = 128;

export class SqliteKnowledgeGraph {
  private readonly deps: SqliteKnowledgeGraphDeps;

  constructor(deps: SqliteKnowledgeGraphDeps) {
    this.deps = deps;
  }

  getAttachmentSnapshot(projectRoot: string): AttachmentSnapshot {
    const db = this.deps.database.knowledgeConnection(projectRoot);
    // 扁平 join 中间行（AttachmentAnchor，RowMapper 中间形状）→ 分组投影
    // （AttachmentSnapshot，T1.2 匹配层契约定稿；superseded 节点不进快照；
    // orphan 锚不进快照——T2.2 失效标记即附着静默）
    const flat = db
      .prepare(
        "SELECT ma.node_id, ma.anchor_path, ma.anchor_symbol, ma.anchor_kind, n.kind, n.name, n.digest, n.status " +
          "FROM materialized_anchors ma JOIN nodes n ON n.id = ma.node_id " +
          "WHERE n.status != 'superseded' AND ma.orphan = 0 " +
          "ORDER BY ma.node_id, ma.anchor_path, ma.anchor_symbol",
      )
      .all() as SnapshotRow[];
    const anchors: AttachmentAnchor[] = flat.map((row) => ({
      nodeId: row.node_id,
      anchorPath: row.anchor_path,
      anchorSymbol: row.anchor_symbol === "" ? null : row.anchor_symbol,
      anchorKind: row.anchor_kind as AnchorKind,
      nodeKind: row.kind as NodeKind,
      nodeName: row.name,
      nodeDigest: row.digest,
      nodeStatus: row.status as NodeStatus,
    }));

    // nodes：按 nodeId 去重（有序稳定基序；scopeKind 取该节点最特异锚域，
    // 仅供匹配层防御性 global 过滤——global 声明本就不物化）
    const nodesById = new Map<string, { id: string; kind: NodeKind; name: string; digest: string; scopeKind: "symbol" | "path" }>();
    for (const anchor of anchors) {
      const existing = nodesById.get(anchor.nodeId);
      if (existing === undefined || (existing.scopeKind === "path" && anchor.anchorKind === "symbol")) {
        nodesById.set(anchor.nodeId, {
          id: anchor.nodeId,
          kind: anchor.nodeKind,
          name: anchor.nodeName,
          digest: anchor.nodeDigest,
          scopeKind: anchor.anchorKind,
        });
      }
    }
    // 路径域锚投影（anchorKind=path → nodeId→file）
    const fileAnchors: FileAnchor[] = anchors
      .filter((a) => a.anchorKind === "path")
      .map((a) => ({ nodeId: a.nodeId, path: a.anchorPath }));
    // 符号域锚投影（LEFT JOIN symbols 取 span；符号消亡/stale → span 缺省，
    // 匹配层降级不猜——T1.2 契约「缺省表示无法参与 L3 兕底」）
    const spanBySymbol = new Map<string, { startLine: number; endLine: number }>();
    for (const row of db.prepare("SELECT file, name, span_start, span_end FROM symbols").all() as SymbolSpanRow[]) {
      spanBySymbol.set(`${row.file}\u0000${row.name}`, { startLine: row.span_start, endLine: row.span_end });
    }
    const symbolAnchors: SymbolAnchor[] = anchors
      .filter((a) => a.anchorKind === "symbol")
      .map((a) => ({
        nodeId: a.nodeId,
        path: a.anchorPath,
        symbol: a.anchorSymbol ?? "",
        ...(a.anchorSymbol !== null
          ? { span: spanBySymbol.get(`${a.anchorPath}\u0000${a.anchorSymbol}`) }
          : {}),
      }));
    // contains 全量投影（匹配层按 file 防御性过滤；类级上溯唯一步径）
    const contains: ContainsEdge[] = (
      db.prepare("SELECT file, outer_symbol, inner_symbol FROM contains_edges ORDER BY file, outer_symbol, inner_symbol").all() as ContainsRow[]
    ).map((row) => ({ outer: row.outer_symbol, inner: row.inner_symbol, file: row.file }));
    return {
      nodes: [...nodesById.values()],
      fileAnchors,
      symbolAnchors,
      contains,
    };
  }

  search(projectRoot: string, q: string): readonly NodeDigestRow[] {
    const db = this.deps.database.knowledgeConnection(projectRoot);
    const escaped = q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const like = `%${escaped}%`;
    const rows = db
      .prepare(
        "SELECT id, kind, name, digest, status, domain FROM nodes " +
          "WHERE name LIKE ? ESCAPE '\\' OR digest LIKE ? ESCAPE '\\' ORDER BY id",
      )
      .all(like, like) as DigestRow[];
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind as NodeKind,
      name: row.name,
      digest: row.digest,
      status: row.status as NodeStatus,
      domain: (row.domain as NodeDomain | null) ?? null,
    }));
  }

  getNode(projectRoot: string, id: string): NodeDetail | null {
    const db = this.deps.database.knowledgeConnection(projectRoot);
    const nodeRow = db
      .prepare(
        "SELECT id, kind, name, digest, body, domain, layer, status, created_at, updated_at FROM nodes WHERE id = ?",
      )
      .get(id) as NodeRow | null;
    if (nodeRow === null) return null;

    const declarations = (
      db
        .prepare("SELECT scope_kind, pattern FROM anchor_decl WHERE node_id = ? ORDER BY scope_kind, pattern")
        .all(id) as DeclRow[]
    ).map<AnchorDeclaration>((row) => ({
      scopeKind: row.scope_kind as AnchorDeclaration["scopeKind"],
      pattern: row.pattern,
    }));

    const materialized = (
      db
        .prepare(
          "SELECT anchor_path, anchor_symbol, anchor_kind, orphan FROM materialized_anchors WHERE node_id = ? " +
            "ORDER BY anchor_path, anchor_symbol",
        )
        .all(id) as MaterializedRow[]
    ).map((row) => ({
      anchorPath: row.anchor_path,
      anchorSymbol: row.anchor_symbol === "" ? null : row.anchor_symbol,
      anchorKind: row.anchor_kind as AnchorKind,
      orphan: row.orphan === 1,
    }));

    const edges: NodeEdgeView[] = [];
    for (const row of db
      .prepare("SELECT verb, dst_id FROM edges WHERE src_id = ? ORDER BY verb, dst_id")
      .all(id) as OutEdgeRow[]) {
      edges.push({ verb: row.verb as EdgeVerb, otherId: row.dst_id, direction: "out" });
    }
    for (const row of db
      .prepare("SELECT verb, src_id FROM edges WHERE dst_id = ? ORDER BY verb, src_id")
      .all(id) as InEdgeRow[]) {
      edges.push({ verb: row.verb as EdgeVerb, otherId: row.src_id, direction: "in" });
    }

    const changeLog = (
      db
        .prepare("SELECT seq, iteration_id, op, node_id, supersede_of, reason, ts FROM change_log WHERE node_id = ? ORDER BY seq")
        .all(id) as LogRow[]
    ).map<ChangeLogEntry>((row) => ({
      seq: row.seq,
      iterationId: row.iteration_id,
      op: row.op as ChangeLogEntry["op"],
      nodeId: row.node_id,
      supersedeOf: row.supersede_of,
      reason: row.reason,
      ts: row.ts,
    }));

    return {
      node: mapNode(nodeRow),
      anchorDeclarations: declarations,
      materializedAnchors: materialized,
      edges,
      supersedeChain: this.buildSupersedeChain(db, id),
      changeLog,
    };
  }

  /**
   * sync 管道基准读面（T2.2 消费）：上一基准 files/symbols + 活跃物化锚
   * （orphan=0）+ 锚声明全集——增量跳过/符号消亡 diff/物化重算差集输入。
   * 知识层通道连接读（WAL 读不阻塞 sync 写）。
   */
  getSyncBaseline(projectRoot: string): SyncBaselineView {
    const db = this.deps.database.knowledgeConnection(projectRoot);
    const files = (
      db.prepare("SELECT path, mtime, sha256 FROM files").all() as FileBaselineRow[]
    ).map((row) => ({ path: row.path, mtime: row.mtime, sha256: row.sha256 }));
    const symbols = (
      db.prepare("SELECT file, name, kind, span_start, span_end FROM symbols").all() as SymbolBaselineRow[]
    ).map((row) => ({
      file: row.file,
      name: row.name,
      kind: row.kind,
      spanStart: row.span_start,
      spanEnd: row.span_end,
    }));
    const activeAnchors = (
      db
        .prepare(
          "SELECT node_id, anchor_path, anchor_symbol, anchor_kind FROM materialized_anchors WHERE orphan = 0 " +
            "ORDER BY node_id, anchor_path, anchor_symbol",
        )
        .all() as ActiveAnchorRow[]
    ).map((row) => ({
      nodeId: row.node_id,
      anchorPath: row.anchor_path,
      anchorSymbol: row.anchor_symbol === "" ? null : row.anchor_symbol,
      anchorKind: row.anchor_kind as AnchorKind,
    }));
    const anchorDeclarations = (
      db.prepare("SELECT node_id, scope_kind, pattern FROM anchor_decl ORDER BY node_id, scope_kind, pattern").all() as DeclFlatRow[]
    ).map((row) => ({
      nodeId: row.node_id,
      scopeKind: row.scope_kind as AnchorDeclRow["scopeKind"],
      pattern: row.pattern,
    }));
    return { files, symbols, activeAnchors, anchorDeclarations };
  }

  getIndexStatus(projectRoot: string): IndexStatus {
    const db = this.deps.database.knowledgeConnection(projectRoot);
    const baselineRow = db.prepare("SELECT value FROM meta WHERE key = ?").get(META_KEYS.baseline) as
      | { value: string }
      | null;
    const degradedRow = db.prepare("SELECT value FROM meta WHERE key = ?").get(META_KEYS.degraded) as
      | { value: string }
      | null;
    const countRow = db.prepare("SELECT COUNT(*) AS n FROM symbols").get() as { n: number };
    return {
      baseline: baselineRow === null ? null : baselineRow.value,
      symbolCount: countRow.n,
      degraded: degradedRow !== null && degradedRow.value === "1",
    };
  }

  /**
   * 验证期检查读面（T5.1）：全节点/全边（原始行）/全物化锚（含 orphan
   * 标记）/锚声明全集/文件面——只读 SELECT，零写路径（AD-6）。
   */
  getVerifyView(projectRoot: string): VerifyView {
    const db = this.deps.database.knowledgeConnection(projectRoot);
    const nodes = (
      db.prepare("SELECT id, kind, name, digest, body, domain, layer, status, created_at, updated_at FROM nodes ORDER BY id").all() as NodeRow[]
    ).map(mapNode);
    const edges = (
      db.prepare("SELECT src_id, verb, dst_id FROM edges ORDER BY src_id, verb, dst_id").all() as RawEdgeDbRow[]
    ).map((row) => ({ srcId: row.src_id, verb: row.verb, dstId: row.dst_id }));
    const anchors = (
      db
        .prepare(
          "SELECT node_id, anchor_path, anchor_symbol, anchor_kind, orphan FROM materialized_anchors " +
            "ORDER BY node_id, anchor_path, anchor_symbol",
        )
        .all() as AnchorWithOrphanRow[]
    ).map<MaterializedAnchor>((row) => ({
      nodeId: row.node_id,
      anchorPath: row.anchor_path,
      anchorSymbol: row.anchor_symbol === "" ? null : row.anchor_symbol,
      anchorKind: row.anchor_kind as AnchorKind,
      orphan: row.orphan === 1,
    }));
    const anchorDeclarations = (
      db.prepare("SELECT node_id, scope_kind, pattern FROM anchor_decl ORDER BY node_id, scope_kind, pattern").all() as DeclFlatRow[]
    ).map((row) => ({
      nodeId: row.node_id,
      scopeKind: row.scope_kind as AnchorDeclRow["scopeKind"],
      pattern: row.pattern,
    }));
    const files = (
      db.prepare("SELECT path, mtime, sha256 FROM files ORDER BY path").all() as FileBaselineRow[]
    ).map((row) => ({ path: row.path, mtime: row.mtime, sha256: row.sha256 }));
    return { nodes, edges, anchors, anchorDeclarations, files };
  }

  /** 变更日志按迭代过滤（T5.1 报告 knowledge_change 数据源；seq 正序）。 */
  getChangeLog(projectRoot: string, iterationId: string): readonly ChangeLogEntry[] {
    const db = this.deps.database.knowledgeConnection(projectRoot);
    return (
      db
        .prepare("SELECT seq, iteration_id, op, node_id, supersede_of, reason, ts FROM change_log WHERE iteration_id = ? ORDER BY seq")
        .all(iterationId) as LogRow[]
    ).map((row) => ({
      seq: row.seq,
      iterationId: row.iteration_id,
      op: row.op as ChangeLogEntry["op"],
      nodeId: row.node_id,
      supersedeOf: row.supersede_of,
      reason: row.reason,
      ts: row.ts,
    }));
  }

  // ── supersede 链组装（双向游走） ──────────────────────────

  /**
   * 链 = older 方向（本节点取代了谁：本节点 create 行 supersede_of）递归 +
   * self + newer 方向（谁取代了本节点：他节点 create 行 supersede_of=本节点）
   * 递归；输出按旧→新排序。环防护：visited 集合；深度防护：步数上限。
   */
  private buildSupersedeChain(db: Database, nodeId: string): SupersedeChainLink[] {
    const visited = new Set<string>([nodeId]);
    const older: SupersedeChainLink[] = [];
    let cursor = nodeId;
    for (let i = 0; i < MAX_CHAIN_WALK; i += 1) {
      const replaced = this.createRowSupersedeOf(db, cursor);
      if (replaced === null || visited.has(replaced)) break;
      visited.add(replaced);
      const link = this.linkOf(db, replaced, "older");
      if (link === null) break;
      older.unshift(link);
      cursor = replaced;
    }
    const newer: SupersedeChainLink[] = [];
    cursor = nodeId;
    for (let i = 0; i < MAX_CHAIN_WALK; i += 1) {
      const replacement = this.replacementOf(db, cursor);
      if (replacement === null || visited.has(replacement)) break;
      visited.add(replacement);
      const link = this.linkOf(db, replacement, "newer");
      if (link === null) break;
      newer.push(link);
      cursor = replacement;
    }
    const self = this.linkOf(db, nodeId, "self");
    if (self === null) return [];
    return [...older, self, ...newer];
  }

  /** 节点 create 行的 supersede_of（本节点取代了谁；无 = null）。 */
  private createRowSupersedeOf(db: Database, nodeId: string): string | null {
    const row = db
      .prepare(
        "SELECT supersede_of FROM change_log WHERE node_id = ? AND op = 'createNode' AND supersede_of IS NOT NULL ORDER BY seq DESC LIMIT 1",
      )
      .get(nodeId) as { supersede_of: string } | null;
    return row === null ? null : row.supersede_of;
  }

  /** 取代本节点的 replacement（其 create 行 supersede_of=本节点；最新一条）。 */
  private replacementOf(db: Database, nodeId: string): string | null {
    const row = db
      .prepare(
        "SELECT node_id FROM change_log WHERE supersede_of = ? AND op = 'createNode' ORDER BY seq DESC LIMIT 1",
      )
      .get(nodeId) as { node_id: string } | null;
    return row === null ? null : row.node_id;
  }

  private linkOf(
    db: Database,
    nodeId: string,
    relation: SupersedeChainLink["relation"],
  ): SupersedeChainLink | null {
    const row = db.prepare("SELECT name, status FROM nodes WHERE id = ?").get(nodeId) as
      | { name: string; status: string }
      | null;
    if (row === null) return null;
    return { nodeId, name: row.name, status: row.status as NodeStatus, relation };
  }
}

function mapNode(row: NodeRow): KnowledgeNode {
  return {
    id: row.id,
    kind: row.kind as NodeKind,
    name: row.name,
    digest: row.digest,
    body: row.body,
    domain: (row.domain as NodeDomain | null) ?? null,
    layer: (row.layer as NodeLayer | null) ?? null,
    status: row.status as NodeStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface NodeRow {
  id: string;
  kind: string;
  name: string;
  digest: string;
  body: string;
  domain: string | null;
  layer: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface SnapshotRow {
  node_id: string;
  anchor_path: string;
  anchor_symbol: string;
  anchor_kind: string;
  kind: string;
  name: string;
  digest: string;
  status: string;
}

interface DigestRow {
  id: string;
  kind: string;
  name: string;
  digest: string;
  status: string;
  domain: string | null;
}

interface DeclRow {
  scope_kind: string;
  pattern: string;
}

interface MaterializedRow {
  anchor_path: string;
  anchor_symbol: string;
  anchor_kind: string;
  orphan: number;
}

interface FileBaselineRow {
  path: string;
  mtime: number;
  sha256: string;
}

interface SymbolBaselineRow {
  file: string;
  name: string;
  kind: string;
  span_start: number;
  span_end: number;
}

interface ActiveAnchorRow {
  node_id: string;
  anchor_path: string;
  anchor_symbol: string;
  anchor_kind: string;
}

interface AnchorWithOrphanRow extends ActiveAnchorRow {
  orphan: number;
}

interface RawEdgeDbRow {
  src_id: string;
  verb: string;
  dst_id: string;
}

interface DeclFlatRow {
  node_id: string;
  scope_kind: string;
  pattern: string;
}

interface SymbolSpanRow {
  file: string;
  name: string;
  span_start: number;
  span_end: number;
}

interface ContainsRow {
  file: string;
  outer_symbol: string;
  inner_symbol: string;
}

interface OutEdgeRow {
  verb: string;
  dst_id: string;
}

interface InEdgeRow {
  verb: string;
  src_id: string;
}

interface LogRow {
  seq: number;
  iteration_id: string;
  op: string;
  node_id: string;
  supersede_of: string | null;
  reason: string | null;
  ts: string;
}
