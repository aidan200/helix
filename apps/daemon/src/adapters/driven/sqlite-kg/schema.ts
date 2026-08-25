/**
 * .kg 单库 schema（iter-20260825-11fo architecture.md §3.1；本文件只有
 * DDL 常量与表名，**不含任何 SQLite 调用**：建库（new Database）、建表
 * （exec）、全部写语句只在 sqlite-kg/KgDatabase.ts 与
 * SqliteKnowledgeStore.ts 内（AG-06 写点白名单）。幂等直建
 * （IF NOT EXISTS），无迁移框架（存量保号迁移走一次性脚本 scripts/oneoff，
 * T5.2）。
 *
 * 表清单（8 张域表 + meta）：
 * - nodes：知识节点（id 主键 TR-n/E-n；name 非唯一——重名合法靠 digest 区分，
 *   AD-16；domain tech/business 降为属性；status 三值枚举 draft/confirmed/
 *   superseded——AD-11 预留+supersede 终态，CHECK 兜底；layer 为 AD-11
 *   bootstrap 分层预留列，词表下迭代冻结故不加 CHECK）；
 * - anchor_decl：锚作用域声明（AD-13：scope_kind 三值 CHECK + pattern；
 *   复合主键幂等去重；global 行 pattern 恒空串）；
 * - change_log：变更日志（每 op 自动追加；supersede_of 挂取代链——supersede
 *   行记自身、replacement createNode 行记被取代者；AUTOINCREMENT 保 seq
 *   追加序）；库内即审计界面（AD-9，git 审计废弃后）；
 * - edges：知识边（verb 封闭词表校验在 service 层 KG_E_VERB——词表单一来源
 *   domain/kg/types.EDGE_VERBS 不进 DDL；复合主键防重复边）；
 * - files/symbols/contains_edges：符号层三表（sync 管道写，增量基准
 *   mtime/sha256；symbols 复合主键 (file,name)，name 索引供附着方法名键查询；
 *   contains 边复合主键 (file,outer,inner)）；
 * - materialized_anchors：物化锚（anchor_kind 两值 CHECK——global 声明永不
 *   物化故无 global 值；anchor_symbol 以 NOT NULL DEFAULT '' 承载「path 锚
 *   无符号」——NULL 在 SQLite 唯一约束中互不相等，空串使复合主键去重成立；
 *   RowMapper 侧 '' ↔ null）；
 * - meta：KV（导入基准戳 sync:baseline + degraded 标记 sync:degraded +
 *   每 kind seq 计数器 seq:rule/seq:entity——发号落库事务内分配，AD-16）。
 */
export const KG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('rule','entity')),
  name TEXT NOT NULL,
  digest TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  domain TEXT CHECK (domain IN ('tech','business')),
  layer TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','superseded')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);

CREATE TABLE IF NOT EXISTS anchor_decl (
  node_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global','path','symbol')),
  pattern TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (node_id, scope_kind, pattern)
);
CREATE INDEX IF NOT EXISTS idx_anchor_decl_node ON anchor_decl(node_id);

CREATE TABLE IF NOT EXISTS change_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  iteration_id TEXT NOT NULL,
  op TEXT NOT NULL,
  node_id TEXT NOT NULL,
  supersede_of TEXT,
  reason TEXT,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_change_log_node ON change_log(node_id);
CREATE INDEX IF NOT EXISTS idx_change_log_supersede_of ON change_log(supersede_of);

CREATE TABLE IF NOT EXISTS edges (
  src_id TEXT NOT NULL,
  verb TEXT NOT NULL,
  dst_id TEXT NOT NULL,
  PRIMARY KEY (src_id, verb, dst_id)
);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_id);

CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  mtime INTEGER NOT NULL,
  sha256 TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS symbols (
  file TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  span_start INTEGER NOT NULL,
  span_end INTEGER NOT NULL,
  PRIMARY KEY (file, name)
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);

CREATE TABLE IF NOT EXISTS contains_edges (
  file TEXT NOT NULL,
  outer_symbol TEXT NOT NULL,
  inner_symbol TEXT NOT NULL,
  PRIMARY KEY (file, outer_symbol, inner_symbol)
);

CREATE TABLE IF NOT EXISTS materialized_anchors (
  node_id TEXT NOT NULL,
  anchor_kind TEXT NOT NULL CHECK (anchor_kind IN ('path','symbol')),
  anchor_path TEXT NOT NULL,
  anchor_symbol TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (node_id, anchor_kind, anchor_path, anchor_symbol)
);
CREATE INDEX IF NOT EXISTS idx_materialized_anchors_path ON materialized_anchors(anchor_path);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** meta 键约定（发号计数器/基准戳/降级标记）。 */
export const META_KEYS = {
  seqPrefix: "seq:", // + kind → seq:rule / seq:entity
  baseline: "sync:baseline",
  degraded: "sync:degraded",
} as const;

/** .kg 库内全部域表名（8 张域表 + meta；测试/守护断言用）。 */
export const KG_TABLES = [
  "nodes",
  "anchor_decl",
  "change_log",
  "edges",
  "files",
  "symbols",
  "contains_edges",
  "materialized_anchors",
  "meta",
] as const;
