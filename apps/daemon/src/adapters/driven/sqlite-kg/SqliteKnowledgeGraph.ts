import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { KgDatabase } from "./KgDatabase";
import { kgDbPath } from "./KgDatabase";
import { META_KEYS } from "./schema";
import type {
  AnchorDeclaration,
  AnchorDeclRow,
  AnchorKind,
  AnchorReverseHit,
  AttachmentAnchor,
  AttachmentSnapshot,
  CandidateListQuery,
  CandidateRow,
  CandidateStatusCounts,
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
        "SELECT ma.node_id, ma.anchor_path, ma.anchor_symbol, ma.anchor_kind, n.kind, n.name, n.digest, n.scene, n.status " +
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
      nodeScene: row.scene,
      nodeStatus: row.status as NodeStatus,
    }));

    // nodes：按 nodeId 去重（有序稳定基序；scopeKind 取该节点最特异锚域，
    // 仅供匹配层防御性 global 过滤——global 声明本就不物化）
    const nodesById = new Map<string, { id: string; kind: NodeKind; name: string; digest: string; scene: string; scopeKind: "symbol" | "path" }>();
    for (const anchor of anchors) {
      const existing = nodesById.get(anchor.nodeId);
      if (existing === undefined || (existing.scopeKind === "path" && anchor.anchorKind === "symbol")) {
        nodesById.set(anchor.nodeId, {
          id: anchor.nodeId,
          kind: anchor.nodeKind,
          name: anchor.nodeName,
          digest: anchor.nodeDigest,
          scene: anchor.nodeScene,
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
        "SELECT id, kind, name, digest, scene, status, domain FROM nodes " +
          "WHERE name LIKE ? ESCAPE '\\' OR digest LIKE ? ESCAPE '\\' ORDER BY id",
      )
      .all(like, like) as DigestRow[];
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind as NodeKind,
      name: row.name,
      digest: row.digest,
      scene: row.scene,
      status: row.status as NodeStatus,
      domain: (row.domain as NodeDomain | null) ?? null,
    }));
  }

  /**
   * 锚反查（R20）：target = 相对路径 / 符号名 / path#symbol → 活跃物化锚
   * （orphan=0）join 非 superseded 节点；物化零命中节点退查 anchor_decl
   * 声明（viaDecl=true）。只读 SELECT（AG-06）。
   */
  reverseAnchorLookup(projectRoot: string, target: string): readonly AnchorReverseHit[] {
    const db = this.deps.database.knowledgeConnection(projectRoot);
    const materialized = (
      db
        .prepare(
          "SELECT ma.node_id, ma.anchor_kind, ma.anchor_path, ma.anchor_symbol, n.kind, n.name, n.digest, n.scene " +
            "FROM materialized_anchors ma JOIN nodes n ON n.id = ma.node_id " +
            "WHERE ma.orphan = 0 AND n.status != 'superseded' " +
            "AND (ma.anchor_path = ? OR ma.anchor_symbol = ? OR (ma.anchor_path || '#' || ma.anchor_symbol) = ?) " +
            "ORDER BY ma.node_id, ma.anchor_kind, ma.anchor_path, ma.anchor_symbol",
        )
        .all(target, target, target) as ReverseRow[]
    ).map<AnchorReverseHit>((row) => ({
      nodeId: row.node_id,
      kind: row.kind as NodeKind,
      name: row.name,
      digest: row.digest,
      scene: row.scene,
      anchorKind: row.anchor_kind as AnchorKind,
      anchorPath: row.anchor_path,
      anchorSymbol: row.anchor_symbol === "" ? null : row.anchor_symbol,
      viaDecl: false,
    }));
    const hitNodes = new Set(materialized.map((h) => h.nodeId));
    // 声明反查兑底（「必要时结合 anchor_decl」）：path/symbol 声明 pattern 按
    // path#symbol 拆解匹配（全等 / path 段 / symbol 段；glob 不展开）；已
    // 物化命中的节点不重复出声明行（物化优先）。
    const decls = db
      .prepare(
        "SELECT ad.node_id, ad.scope_kind, ad.pattern, n.kind, n.name, n.digest, n.scene " +
          "FROM anchor_decl ad JOIN nodes n ON n.id = ad.node_id " +
          "WHERE n.status != 'superseded' AND ad.scope_kind IN ('path','symbol') " +
          "ORDER BY ad.node_id, ad.scope_kind, ad.pattern",
      )
      .all() as DeclJoinRow[];
    const out = [...materialized];
    const declSeen = new Set<string>();
    for (const row of decls) {
      if (hitNodes.has(row.node_id)) continue;
      const hashIndex = row.pattern.indexOf("#");
      const pathPart = hashIndex === -1 ? row.pattern : row.pattern.slice(0, hashIndex);
      const symbolPart = hashIndex === -1 ? null : row.pattern.slice(hashIndex + 1);
      const matched =
        target === row.pattern || target === pathPart || (symbolPart !== null && symbolPart !== "" && target === symbolPart);
      if (!matched) continue;
      if (declSeen.has(row.node_id)) continue;
      declSeen.add(row.node_id);
      out.push({
        nodeId: row.node_id,
        kind: row.kind as NodeKind,
        name: row.name,
        digest: row.digest,
        scene: row.scene,
        anchorKind: row.scope_kind as AnchorKind,
        anchorPath: pathPart,
        anchorSymbol: symbolPart,
        viaDecl: true,
      });
    }
    return out;
  }

  getNode(projectRoot: string, id: string): NodeDetail | null {
    const db = this.deps.database.knowledgeConnection(projectRoot);
    const nodeRow = db
      .prepare(
        "SELECT id, kind, name, digest, scene, body, domain, layer, origin_batch_id, status, created_at, updated_at FROM nodes WHERE id = ?",
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
        .prepare(
          "SELECT seq, iteration_id, task_id, op, node_id, supersede_of, reason, ts FROM change_log WHERE node_id = ? ORDER BY seq",
        )
        .all(id) as LogRow[]
    ).map<ChangeLogEntry>((row) => ({
      seq: row.seq,
      iterationId: row.iteration_id,
      taskId: row.task_id,
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
      db.prepare(
        "SELECT id, kind, name, digest, scene, body, domain, layer, origin_batch_id, status, created_at, updated_at FROM nodes ORDER BY id",
      ).all() as NodeRow[]
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

  /** 变更日志按迭代过滤（T5.1 报告 knowledge_change 数据源；seq 正序）。
   *  iterationId=null（P0 ④）→ 无迭代归属行（WHERE iteration_id IS NULL——
   *  去残留聚合口径；历史非空行照旧按值过滤）。 */
  getChangeLog(projectRoot: string, iterationId: string | null): readonly ChangeLogEntry[] {
    const db = this.deps.database.knowledgeConnection(projectRoot);
    const rows = (
      iterationId === null
        ? db
            .prepare(
              "SELECT seq, iteration_id, task_id, op, node_id, supersede_of, reason, ts FROM change_log WHERE iteration_id IS NULL ORDER BY seq",
            )
            .all()
        : db
            .prepare(
              "SELECT seq, iteration_id, task_id, op, node_id, supersede_of, reason, ts FROM change_log WHERE iteration_id = ? ORDER BY seq",
            )
            .all(iterationId)
    ) as LogRow[];
    return rows.map((row) => ({
      seq: row.seq,
      iterationId: row.iteration_id,
      taskId: row.task_id,
      op: row.op as ChangeLogEntry["op"],
      nodeId: row.node_id,
      supersedeOf: row.supersede_of,
      reason: row.reason,
      ts: row.ts,
    }));
  }

  /** 知识节点计数（kg.list total 数据源——过滤前全集含 superseded；只读 COUNT）。 */
  countNodes(projectRoot: string): number {
    const db = this.deps.database.knowledgeConnection(projectRoot);
    const row = db.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number };
    return row.n;
  }

  /**
   * 非 superseded 节点计数（T3.2，contracts/kg-bootstrap-api.md §1：bootstrap
   * 准入「知识层为空」机械定义 + kg.projects nodeCount 口径——留史行不计入）。
   */
  countActiveNodes(projectRoot: string): number {
    const db = this.deps.database.knowledgeConnection(projectRoot);
    const row = db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE status != 'superseded'").get() as { n: number };
    return row.n;
  }

  /**
   * 非 superseded 且带 layer 的产出节点计数（O-9：bootstrap 准入「知识层为空」
   * 精化口径——sediment 沉淀节点 layer 为 NULL，不算产出、不阻挡入口）。
   */
  countActiveLayeredNodes(projectRoot: string): number {
    const db = this.deps.database.knowledgeConnection(projectRoot);
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM nodes WHERE status != 'superseded' AND layer IS NOT NULL")
      .get() as { n: number };
    return row.n;
  }

  /**
   * 按产出批次反查节点 id 集（T2.2 F2.7 阶段产物聚合数据源）：nodes.
   * origin_batch_id ∈ batchIds（T2.1 元数据列），排除 superseded（已被重跑
   * 取代的旧产出不进阶段产物）；id 升序确定性。只读，零写路径。
   */
  listNodeIdsByOriginBatches(projectRoot: string, batchIds: readonly string[]): readonly string[] {
    if (batchIds.length === 0) return [];
    const db = this.deps.database.knowledgeConnection(projectRoot);
    const placeholders = batchIds.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT id FROM nodes WHERE origin_batch_id IN (${placeholders}) AND status != 'superseded' ORDER BY id`,
      )
      .all(...batchIds) as { id: string }[];
    return rows.map((row) => row.id);
  }

  /** 库内最近一次变更所属迭代 id（T5.3 当前迭代确定性推导；空 → null）。
   *  P0 ④：取 change_log 末行字面值——末行无归属（NULL）即无锚（老库 v1
   *  冻结值不随末行 NULL 自我延续）；读面纪律：库文件缺席 → null
   *  （不新建库文件——connectionOf 会 mkdir+建库）。 */
  latestIteration(projectRoot: string): string | null {
    if (!existsSync(kgDbPath(projectRoot))) return null;
    const db = this.deps.database.knowledgeConnection(projectRoot);
    const row = db
      .prepare("SELECT iteration_id FROM change_log ORDER BY seq DESC LIMIT 1")
      .get() as { iteration_id: string | null } | null;
    return row === null ? null : row.iteration_id;
  }

  /**
   * candidates 台账四态计数（W2-E kg.health 数据源：GROUP BY status 一次
   * 聚合，缺态 = 0；只读，零写路径——调用方先行 hasIndex 判定）。
   */
  countCandidatesByStatus(projectRoot: string): CandidateStatusCounts {
    const db = this.deps.database.knowledgeConnection(projectRoot);
    const rows = db
      .prepare("SELECT status, COUNT(*) AS n FROM candidates GROUP BY status")
      .all() as { status: string; n: number }[];
    const counts = { pending: 0, deferred: 0, applied: 0, discarded: 0 };
    for (const row of rows) {
      if (row.status === "pending") counts.pending = row.n;
      else if (row.status === "deferred") counts.deferred = row.n;
      else if (row.status === "applied") counts.applied = row.n;
      else if (row.status === "discarded") counts.discarded = row.n;
    }
    return counts;
  }

  /**
   * candidates 台账列表读面（三件套共同数据面）：status 过滤 + limit/offset
   * 分页，缺省全量最新在前（rowid 序——插入序与 CAND-<seq> 发号序一致，
   * 避免 TEXT id 字典序 CAND-10 < CAND-2 乱序）；行含 body 全文（agent
   * 清台判读需要）。只读 SELECT（AG-06 写点白名单不含本文件）。
   */
  listCandidates(projectRoot: string, query: CandidateListQuery): readonly CandidateRow[] {
    const db = this.deps.database.knowledgeConnection(projectRoot);
    const sql =
      "SELECT id, formal_id, kind, title, body, status, source_task_id, source_iteration_id, defer_age, target_node, " +
      "created_at, decided_at, decision_reason, applied_node_id FROM candidates " +
      (query.status !== undefined ? "WHERE status = ? " : "") +
      "ORDER BY rowid DESC LIMIT ? OFFSET ?";
    const limit = query.limit !== undefined && Number.isInteger(query.limit) && query.limit > 0 ? query.limit : -1;
    const offset = query.offset !== undefined && Number.isInteger(query.offset) && query.offset > 0 ? query.offset : 0;
    const rows = (
      query.status !== undefined
        ? db.prepare(sql).all(query.status, limit, offset)
        : db.prepare(sql).all(limit, offset)
    ) as CandidateListDbRow[];
    return rows.map((row) => ({
      id: row.id,
      formalId: row.formal_id,
      kind: row.kind as CandidateRow["kind"],
      title: row.title,
      body: row.body,
      status: row.status as CandidateRow["status"],
      sourceTaskId: row.source_task_id,
      sourceIterationId: row.source_iteration_id,
      deferAge: row.defer_age,
      targetNode: row.target_node,
      createdAt: row.created_at,
      decidedAt: row.decided_at,
      decisionReason: row.decision_reason,
      appliedNodeId: row.applied_node_id,
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
    scene: row.scene,
    body: row.body,
    domain: (row.domain as NodeDomain | null) ?? null,
    layer: (row.layer as NodeLayer | null) ?? null,
    originBatchId: (row.origin_batch_id as string | null) ?? null,
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
  scene: string;
  body: string;
  domain: string | null;
  layer: string | null;
  origin_batch_id: string | null;
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
  scene: string;
  status: string;
}

interface DigestRow {
  id: string;
  kind: string;
  name: string;
  digest: string;
  scene: string;
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

interface ReverseRow extends ActiveAnchorRow {
  kind: string;
  name: string;
  digest: string;
  scene: string;
}

interface DeclJoinRow {
  node_id: string;
  scope_kind: string;
  pattern: string;
  kind: string;
  name: string;
  digest: string;
  scene: string;
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
  iteration_id: string | null;
  task_id: string | null;
  op: string;
  node_id: string;
  supersede_of: string | null;
  reason: string | null;
  ts: string;
}

/** candidates 台账行（listCandidates 读面投影形状；列级演进后 target_node 可空）。 */
interface CandidateListDbRow {
  id: string;
  formal_id: string | null;
  kind: string;
  title: string;
  body: string;
  status: string;
  source_task_id: string | null;
  source_iteration_id: string | null;
  defer_age: number;
  target_node: string | null;
  created_at: string;
  decided_at: string | null;
  decision_reason: string | null;
  applied_node_id: string | null;
}
