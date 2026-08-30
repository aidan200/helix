import { Database } from "bun:sqlite";
import type { KgDatabase } from "./KgDatabase";
import { META_KEYS } from "./schema";
import type { KgPurgeSummary } from "../../../application/ports/outbound/KnowledgeStorePort";
import { formatNodeId, parseMigrationId } from "../../../domain/kg/node-id";
import { supersedeTransition } from "../../../domain/kg/supersede";
import type {
  KgWriteError,
  KnowledgeWriteOp,
  NodeDraft,
  NodeKind,
  NodeStatus,
  SymbolBatch,
  WriteResult,
} from "../../../domain/kg/types";

/**
 * SqliteKnowledgeStore —— KnowledgeStorePort 的 SQLite 实现（.kg 单库）。
 *
 * 写点纪律（AG-06 白名单写点之二，本文件与 WriteQueue 并列）：知识层
 * 写语句唯一收口于此；按表分域与符号层通道（applySync）互不竞争
 * （AD-15：两通道不同表集、各自连接+事务）。
 *
 * - writeKnowledge：单 op 单事务（BEGIN IMMEDIATE）——编号事务内分配、
 *   change_log 自动追加、引用完整性（存在性/冲突/supersede 状态机）事务内
 *   查出；预期失败返回结构化 WriteResult（KG_E_ID/KG_E_STATE），意外故障
 *   回滚后 KG_E_INTERNAL，永不落半态；
 * - applySync：sync 单事务（符号层三表 upsert + 物化锚 + meta 基准戳/degraded），
 *   中途故障抛出由调用方（KgSyncService，T2.2）处置。
 *
 * schema 校验在 KgWriteService 前置完成（AD-9），本层不重复校验参数形态。
 */
export interface SqliteKnowledgeStoreDeps {
  readonly database: KgDatabase;
}

export class SqliteKnowledgeStore {
  private readonly deps: SqliteKnowledgeStoreDeps;

  constructor(deps: SqliteKnowledgeStoreDeps) {
    this.deps = deps;
  }

  // ── 知识层通道（四表，单 op 单事务） ──────────────────────

  writeKnowledge(projectRoot: string, op: KnowledgeWriteOp): WriteResult {
    const db = this.deps.database.knowledgeConnection(projectRoot);
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.applyOp(db, op);
      if (!result.ok) {
        // 结构化拒绝的回滚路径：单 op 语义下拒绝点先于任何写语句（空事务，
        // 回滚与提交观察等价）；batchCreateNodes 可能已落前序节点——一律回滚
        // 保「零部分落库」（O-5 整批原子：任一节点失败整批拒绝）。
        this.rollbackQuietly(db);
        return result;
      }
      db.exec("COMMIT");
      return result;
    } catch (error) {
      this.rollbackQuietly(db);
      return {
        ok: false,
        error: {
          code: "KG_E_INTERNAL",
          message: `知识层写入事务失败已回滚：${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }

  private applyOp(db: Database, op: KnowledgeWriteOp): WriteResult {
    switch (op.kind) {
      case "createNode":
        return this.applyCreateNode(db, op.iterationId, op.draft, op.id, op.taskId, op.originBatchId);
      case "updateNode":
        return this.applyUpdateNode(db, op);
      case "supersede":
        return this.applySupersede(db, op);
      case "declareAnchors":
        return this.applyDeclareAnchors(db, op);
      case "addEdge":
        return this.applyAddEdge(db, op);
      case "batchCreateNodes":
        return this.applyBatchCreateNodes(db, op);
    }
  }

  /**
   * batchCreateNodes 落库（T2.1，O-5）：逐项复用单条 createNode 全部语义
   * （发号/保号/元数据/change_log）；任一项结构化失败 → 携带项序号返回，
   * 整批回滚由 writeKnowledge 统一执行（零部分落库）。元数据（taskId/
   * originBatchId）为 op 级——逐节点同源登记。 */
  private applyBatchCreateNodes(
    db: Database,
    op: KnowledgeWriteOp & { kind: "batchCreateNodes" },
  ): WriteResult {
    let lastId: string | null = null;
    for (let i = 0; i < op.nodes.length; i += 1) {
      const payload = op.nodes[i]!;
      const result = this.applyCreateNode(
        db,
        op.iterationId,
        payload.draft,
        payload.id,
        op.taskId,
        op.originBatchId,
      );
      if (!result.ok) {
        return {
          ok: false,
          error: {
            code: result.error.code,
            message: `批量第 ${i} 项（0-based）失败，整批已回滚：${result.error.message}`,
            path: rebaseBatchPath(result.error.path, i),
          },
        };
      }
      lastId = result.nodeId;
    }
    return { ok: true, nodeId: lastId! };
  }

  private applyCreateNode(
    db: Database,
    iterationId: string,
    draft: NodeDraft,
    explicitId: string | undefined,
    taskId: string | undefined,
    originBatchId: string | undefined,
  ): WriteResult {
    let id: string;
    if (explicitId !== undefined) {
      // 保号迁移入口（T5.2）：显式 id 接受全存量形态（TR-AD-N / TR-TEST-N /
      // E-中文尾缀 / 新号空间）；只要求不冲突（形态/前缀校验在上层）；
      // 计数器推进到显式号（数字尾缀可提取时；非数字尾缀不推进——只增不减
      // 永不复用，后续自动发号不会回卷撞号）
      const seq = parseMigrationId(explicitId);
      if (seq === null) {
        return err("KG_E_SCHEMA", `显式 id ${explicitId} 不在保号/新号形态内`, "op.id");
      }
      if (seq.kind !== draft.kind) {
        return err("KG_E_SCHEMA", `显式 id 前缀与 kind 不符（${explicitId} vs ${draft.kind}）`, "op.id");
      }
      if (this.nodeExists(db, explicitId)) {
        return err("KG_E_ID", `节点 ${explicitId} 已存在（id 永不回收、永不改写）`, "op.id");
      }
      if (seq.seq !== null) this.bumpSeq(db, seq.kind, seq.seq);
      id = explicitId;
    } else {
      id = formatNodeId(draft.kind, this.allocateSeq(db, draft.kind));
    }
    const now = isoNow();
    db.prepare(
      "INSERT INTO nodes (id, kind, name, digest, body, domain, layer, origin_batch_id, status, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, draft.kind, draft.name, draft.digest, draft.body ?? "", draft.domain ?? null, draft.layer ?? null, originBatchId ?? null, draft.status ?? "draft", now, now);
    this.appendChangeLog(db, iterationId, "createNode", id, null, null, taskId);
    return { ok: true, nodeId: id };
  }

  private applyUpdateNode(
    db: Database,
    op: KnowledgeWriteOp & { kind: "updateNode" },
  ): WriteResult {
    const current = this.loadNode(db, op.nodeId);
    if (current === null) {
      return err("KG_E_ID", `节点 ${op.nodeId} 不存在`, "op.nodeId");
    }
    const patch = op.patch;
    db.prepare("UPDATE nodes SET name = ?, digest = ?, body = ?, domain = ?, layer = ?, status = ?, updated_at = ? WHERE id = ?").run(
      patch.name ?? current.name,
      patch.digest ?? current.digest,
      patch.body ?? current.body,
      patch.domain !== undefined ? patch.domain : current.domain,
      patch.layer !== undefined ? patch.layer : current.layer,
      patch.status ?? current.status,
      isoNow(),
      op.nodeId,
    );
    this.appendChangeLog(db, op.iterationId, "updateNode", op.nodeId, null, op.patch.reason ?? null, op.taskId);
    return { ok: true, nodeId: op.nodeId };
  }

  private applySupersede(
    db: Database,
    op: KnowledgeWriteOp & { kind: "supersede" },
  ): WriteResult {
    const current = this.loadNode(db, op.nodeId);
    if (current === null) {
      return err("KG_E_ID", `节点 ${op.nodeId} 不存在`, "op.nodeId");
    }
    const transition = supersedeTransition(current.status as NodeStatus);
    if (!transition.ok) {
      return err("KG_E_STATE", `节点 ${op.nodeId} 已是 superseded 终态（id 永不回收，再推翻走 replacement 新号）`, "op.nodeId");
    }
    db.prepare("UPDATE nodes SET status = ?, updated_at = ? WHERE id = ?").run(
      transition.next,
      isoNow(),
      op.nodeId,
    );
    // supersede_of=自身：目标节点翻态行挂入自身历史链（supersede 链查询锚点）
    this.appendChangeLog(db, op.iterationId, "supersede", op.nodeId, op.nodeId, op.reason, op.taskId);
    if (op.replacementNodeDraft === undefined) return { ok: true, nodeId: op.nodeId };
    // replacement 另发新号（AD-16：新知识新号；createNode 行 supersede_of=被取代者——链上新节点挂旧链）
    const replacementId = formatNodeId(
      op.replacementNodeDraft.kind,
      this.allocateSeq(db, op.replacementNodeDraft.kind),
    );
    const draft = op.replacementNodeDraft;
    const now = isoNow();
    // origin_batch_id 同 createNode 落列（T4.2/AF-T4.1.6：replacement 同为批次产出，
    // 缺列曾致 origin_batch_id 永 NULL 的落章裂口）
    db.prepare(
      "INSERT INTO nodes (id, kind, name, digest, body, domain, layer, origin_batch_id, status, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(replacementId, draft.kind, draft.name, draft.digest, draft.body ?? "", draft.domain ?? null, draft.layer ?? null, op.originBatchId ?? null, draft.status ?? "draft", now, now);
    this.appendChangeLog(db, op.iterationId, "createNode", replacementId, op.nodeId, op.reason, op.taskId);
    return { ok: true, nodeId: replacementId };
  }

  private applyDeclareAnchors(
    db: Database,
    op: KnowledgeWriteOp & { kind: "declareAnchors" },
  ): WriteResult {
    if (!this.nodeExists(db, op.nodeId)) {
      return err("KG_E_ID", `节点 ${op.nodeId} 不存在`, "op.nodeId");
    }
    // 声明语义 = 全集替换（declarative：本次声明即当前作用域全集）
    db.prepare("DELETE FROM anchor_decl WHERE node_id = ?").run(op.nodeId);
    for (const anchor of op.anchors) {
      // pattern 缺省归一 ""（global 声明可省略；上层已校验 path/symbol 必携带）
      db.prepare("INSERT INTO anchor_decl (node_id, scope_kind, pattern) VALUES (?, ?, ?)").run(
        op.nodeId,
        anchor.scopeKind,
        anchor.pattern ?? "",
      );
    }
    this.appendChangeLog(db, op.iterationId, "declareAnchors", op.nodeId, null, null, op.taskId);
    return { ok: true, nodeId: op.nodeId };
  }

  private applyAddEdge(db: Database, op: KnowledgeWriteOp & { kind: "addEdge" }): WriteResult {
    if (!this.nodeExists(db, op.srcId)) {
      return err("KG_E_ID", `边起点 ${op.srcId} 不存在`, "op.srcId");
    }
    if (!this.nodeExists(db, op.dstId)) {
      return err("KG_E_ID", `边终点 ${op.dstId} 不存在`, "op.dstId");
    }
    // OR IGNORE：同边重复声明幂等（复合主键去重；重声明不改语义）
    db.prepare("INSERT OR IGNORE INTO edges (src_id, verb, dst_id) VALUES (?, ?, ?)").run(
      op.srcId,
      op.verb,
      op.dstId,
    );
    this.appendChangeLog(db, op.iterationId, "addEdge", op.srcId, null, null, op.taskId);
    return { ok: true, nodeId: op.srcId };
  }

  // ── 符号层通道（sync 单事务，T2.2 消费） ──────────────────

  async applySync(projectRoot: string, batch: SymbolBatch): Promise<void> {
    const db = this.deps.database.syncConnection(projectRoot);
    db.exec("BEGIN IMMEDIATE");
    try {
      // 删除通道（增量 diff，T2.2）：窗口内删除/改名文件 → 整文件符号行 +
      // contains 边 + files 基准行清除
      const deleteContains = db.prepare("DELETE FROM contains_edges WHERE file = ?");
      const deleteSymbols = db.prepare("DELETE FROM symbols WHERE file = ?");
      const deleteFile = db.prepare("DELETE FROM files WHERE path = ?");
      for (const path of batch.deletedFiles ?? []) {
        deleteContains.run(path);
        deleteSymbols.run(path);
        deleteFile.run(path);
      }
      // 导入域整文件替换：先清该文件旧符号/contains 再插入新投影（符号级
      // 消亡 diff 载体——同文件内函数删除/改名时旧符号行随导入清除；
      // files 基准行走 upsert 保留新 mtime/hash）
      for (const file of batch.files) {
        deleteContains.run(file.path);
        deleteSymbols.run(file.path);
      }
      // 失效通道（CL-2.A7）：orphan 标记保留行不物理删（供 T5.1 检出）
      const markOrphan = db.prepare(
        "UPDATE materialized_anchors SET orphan = 1 " +
          "WHERE node_id = ? AND anchor_kind = ? AND anchor_path = ? AND anchor_symbol = ?",
      );
      for (const anchor of batch.orphanedAnchors ?? []) {
        markOrphan.run(anchor.nodeId, anchor.anchorKind, anchor.anchorPath, anchor.anchorSymbol ?? "");
      }
      const upsertFile = db.prepare(
        "INSERT INTO files (path, mtime, sha256) VALUES (?, ?, ?) " +
          "ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, sha256 = excluded.sha256",
      );
      for (const file of batch.files) {
        upsertFile.run(file.path, file.mtime, file.sha256);
      }
      const upsertSymbol = db.prepare(
        "INSERT INTO symbols (file, name, kind, span_start, span_end) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(file, name) DO UPDATE SET kind = excluded.kind, span_start = excluded.span_start, span_end = excluded.span_end",
      );
      for (const symbol of batch.symbols) {
        upsertSymbol.run(symbol.file, symbol.name, symbol.kind, symbol.spanStart, symbol.spanEnd);
      }
      const upsertContains = db.prepare(
        "INSERT INTO contains_edges (file, outer_symbol, inner_symbol) VALUES (?, ?, ?) " +
          "ON CONFLICT(file, outer_symbol, inner_symbol) DO NOTHING",
      );
      for (const edge of batch.containsEdges) {
        upsertContains.run(edge.file, edge.outerSymbol, edge.innerSymbol);
      }
      const upsertAnchor = db.prepare(
        "INSERT INTO materialized_anchors (node_id, anchor_kind, anchor_path, anchor_symbol, orphan) VALUES (?, ?, ?, ?, 0) " +
          "ON CONFLICT(node_id, anchor_kind, anchor_path, anchor_symbol) DO UPDATE SET orphan = 0",
      );
      for (const anchor of batch.materializedAnchors) {
        // anchorSymbol '' ↔ null（path 锚无符号；见 schema.ts 说明）
        upsertAnchor.run(anchor.nodeId, anchor.anchorKind, anchor.anchorPath, anchor.anchorSymbol ?? "");
      }
      // meta 最后落（故障时基准戳不推进——时序可判定，AD-15）
      const upsertMeta = db.prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      );
      upsertMeta.run(META_KEYS.baseline, batch.baseline);
      upsertMeta.run(META_KEYS.degraded, batch.degraded ? "1" : "0");
      db.exec("COMMIT");
    } catch (error) {
      this.rollbackQuietly(db);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  // ── 维护面（C1：kg.graph.purge / kg.index.delete 消费） ─────────

  /**
   * purge 全清：九表全部清零，单事务（知识层通道连接跨面执行——purge 是
   * 跨双通道域的管理面操作，busy_timeout 吸收与在途 sync 写的事务竞争；
   * 调用方已先清 sync 定时器）。meta 全清含 seq 发号计数器——全库归零后
   * 重新发号自 TR-1/E-1 起（历史行已随库清零，无复用冲突面）。
   */
  purgeAll(projectRoot: string): KgPurgeSummary {
    const db = this.deps.database.knowledgeConnection(projectRoot);
    db.exec("BEGIN IMMEDIATE");
    try {
      const count = (table: string): number =>
        (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      const summary: KgPurgeSummary = {
        nodesRemoved: count("nodes"),
        symbolsRemoved: count("symbols"),
        filesRemoved: count("files"),
      };
      for (const table of [
        "nodes",
        "anchor_decl",
        "change_log",
        "edges",
        "materialized_anchors",
        "files",
        "symbols",
        "contains_edges",
        "meta",
      ]) {
        db.exec(`DELETE FROM ${table}`);
      }
      db.exec("COMMIT");
      return summary;
    } catch (error) {
      this.rollbackQuietly(db);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * 索引面复位（符号层通道）：files/symbols/contains_edges 清零 + meta
   * sync:baseline/sync:degraded 删除 → getIndexStatus 回落 absent。物化锚
   * 保留（知识层邻接面；重建 sync 全量重算 upsert 回活跃），seq 计数器不动。
   */
  resetIndexFace(projectRoot: string): void {
    const db = this.deps.database.syncConnection(projectRoot);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("DELETE FROM contains_edges");
      db.exec("DELETE FROM symbols");
      db.exec("DELETE FROM files");
      db.prepare("DELETE FROM meta WHERE key IN (?, ?)").run(META_KEYS.baseline, META_KEYS.degraded);
      db.exec("COMMIT");
    } catch (error) {
      this.rollbackQuietly(db);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  // ── 内部：发号 / 日志 / 行访问 ────────────────────────────

  /** 序号事务内分配（AD-16：计数器只增，+1 后立即落库防复用）。 */
  private allocateSeq(db: Database, kind: NodeKind): number {
    const next = this.currentSeq(db, kind) + 1;
    this.setSeq(db, kind, next);
    return next;
  }

  /** 显式保号迁移推进计数器（seq 高于计数器时抬升；低于则不动——只增不减）。 */
  private bumpSeq(db: Database, kind: NodeKind, seq: number): void {
    if (seq > this.currentSeq(db, kind)) this.setSeq(db, kind, seq);
  }

  private currentSeq(db: Database, kind: NodeKind): number {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(`${META_KEYS.seqPrefix}${kind}`) as
      | { value: string }
      | null;
    return row === null ? 0 : Number(row.value);
  }

  private setSeq(db: Database, kind: NodeKind, seq: number): void {
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      `${META_KEYS.seqPrefix}${kind}`,
      String(seq),
    );
  }

  /**
   * change_log 追加（T2.1 起 task_id 与 iteration_id 并列记账——op 携带
   * taskId 则落列，不携带 = null，旧行为不变）。
   */
  private appendChangeLog(
    db: Database,
    iterationId: string,
    op: KnowledgeWriteOp["kind"],
    nodeId: string,
    supersedeOf: string | null,
    reason: string | null,
    taskId: string | undefined = undefined,
  ): void {
    db.prepare(
      "INSERT INTO change_log (iteration_id, task_id, op, node_id, supersede_of, reason, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(iterationId, taskId ?? null, op, nodeId, supersedeOf, reason, isoNow());
  }

  private nodeExists(db: Database, id: string): boolean {
    return db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(id) !== null;
  }

  private loadNode(db: Database, id: string): NodeRow | null {
    return (db.prepare(
      "SELECT id, kind, name, digest, body, domain, layer, status, created_at, updated_at FROM nodes WHERE id = ?",
    ).get(id) as NodeRow | null);
  }

  private rollbackQuietly(db: Database): void {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 事务未开（BEGIN 即失败）——无半态可回滚
    }
  }
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

function err(code: KgWriteError["code"], message: string, path?: string): WriteResult {
  return { ok: false, error: { code, message, ...(path !== undefined ? { path } : {}) } };
}

/**
 * 批量项错误路径改挂（T2.1）：单条语义路径（op.id / op.draft…）→ 批量项
 * 序号路径（op.nodes[i].id / op.nodes[i].draft…）；无路径 → 序号项本身。
 */
function rebaseBatchPath(path: string | undefined, index: number): string {
  if (path === undefined) return `op.nodes[${index}]`;
  return path.startsWith("op.") ? `op.nodes[${index}].${path.slice("op.".length)}` : path;
}

function isoNow(): string {
  return new Date().toISOString();
}
