/**
 * 守护式 schema 演进（architecture.md §8.1；WriteQueue 拆分，体量治理）。
 * helix.db 会话域列级演进 + legacy 数据迁移的宿主——AG-06 白名单成员
 * （DDL/exec 写语句宿主；任务四表 DML 仍在 WriteQueue.ts，O-1 表分域）。
 */
import type { Database } from "bun:sqlite";
import { LEGACY_MAIN_INSTANCE_ID } from "../../../domain/agent/AgentInstance";

/**
 * 启动期列级演进（幂等，每次打开执行，已演进则全部 no-op）：
 *
 * - domain_events.agent_instance_id / tool_calls.instance_id 缺列 →
 *   ALTER TABLE ADD COLUMN TEXT NOT NULL DEFAULT 'main'——SQLite 对
 *   NOT NULL 补列强制要求 DEFAULT，恰与旧行回填机制吻合：
 *   存量行自动落 'main'（主实例固定 id），新行恒显式写入。
 * - agent_lifecycle 单列 PK → (session_id, instance_id)：SQLite 无法
 *   ALTER 主键，走守护式重建（rename→create→copy→drop，事务包裹原子；
 *   旧行 instance_id 回填 'main'）。重建表形状与 schema.ts 新建表一致。
 *
 * 不做迁移框架（迭代边界）：无版本表、无回滚——检测即修，崩溃安全靠事务。
 */
export function ensureSchemaEvolved(db: Database): void {
  if (!hasColumn(db, "domain_events", "agent_instance_id")) {
    db.exec("ALTER TABLE domain_events ADD COLUMN agent_instance_id TEXT NOT NULL DEFAULT 'main'");
  }
  if (!hasColumn(db, "tool_calls", "instance_id")) {
    db.exec("ALTER TABLE tool_calls ADD COLUMN instance_id TEXT NOT NULL DEFAULT 'main'");
  }
  // 图片下行：tool_calls.images（data URL 数组 JSON 文本；可空无默认——
  // 旧行 NULL = 无图，读取侧 undefined 前向兼容）
  if (!hasColumn(db, "tool_calls", "images")) {
    db.exec("ALTER TABLE tool_calls ADD COLUMN images TEXT");
  }
  // T11a：steer_queue.source（注入来源 user/closure/progress；可空无默认——
  // 旧行 NULL = 缺省 user 语义，读取侧键不携带前向兼容）
  if (!hasColumn(db, "steer_queue", "source")) {
    db.exec("ALTER TABLE steer_queue ADD COLUMN source TEXT");
  }
  // T10a 方案 A：session_state.main_instance_id（会话主实例 id，agent-<唯一串>；
  // 可空无默认——旧行 NULL = legacy "main"，读取侧兜底前向兼容）
  if (!hasColumn(db, "session_state", "main_instance_id")) {
    db.exec("ALTER TABLE session_state ADD COLUMN main_instance_id TEXT");
  }
  // findings 文件 canonical（信封 findings 退役）：closure_records.findings_file
  // 指针列（daemon 机械探测注入；可空无默认——旧行 NULL = 内嵌 findings 兼容
  // 读面双源，读取侧 findingsFile 优先/内嵌兜底）
  if (!hasColumn(db, "closure_records", "findings_file")) {
    db.exec("ALTER TABLE closure_records ADD COLUMN findings_file TEXT");
  }
  // P1 T3：session_state.mode（会话模式，建会话定格；可空无默认——旧行
  // NULL = default 语义，读取侧恢复链归一，与 main_instance_id 同构）
  if (!hasColumn(db, "session_state", "mode")) {
    db.exec("ALTER TABLE session_state ADD COLUMN mode TEXT");
  }
  const lifecycleCols = tableColumns(db, "agent_lifecycle");
  if (lifecycleCols.length > 0 && !lifecycleCols.includes("instance_id")) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("DROP TABLE IF EXISTS agent_lifecycle_rebuild"); // 上次崩溃残留防御（事务内不可达，保险）
      db.exec("ALTER TABLE agent_lifecycle RENAME TO agent_lifecycle_rebuild");
      db.exec(
        "CREATE TABLE agent_lifecycle (" +
          "session_id TEXT NOT NULL, " +
          `instance_id TEXT NOT NULL DEFAULT '${LEGACY_MAIN_INSTANCE_ID}', ` +
          "state TEXT NOT NULL, " +
          "updated_at TEXT NOT NULL, " +
          "PRIMARY KEY (session_id, instance_id))",
      );
      db.exec(
        "INSERT INTO agent_lifecycle (session_id, instance_id, state, updated_at) " +
          `SELECT session_id, '${LEGACY_MAIN_INSTANCE_ID}', state, updated_at FROM agent_lifecycle_rebuild`,
      );
      db.exec("DROP TABLE agent_lifecycle_rebuild");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error; // 迁移失败快速失败：daemon 不带病启动
    }
  }
  // updated_at 语义修复回填（R-会话排序）：updated_at 历史上取「落盘墙钟」，
  // daemon 关闭 sealAll（stopped 里程碑落盘）/空闲卸载会把全部会话 updated_at
  // 抹平成同一时刻——清单 ORDER BY updated_at 的「最近使用」排序被破坏。
  // 写面已改取最后一条 entry 的 createdAt（RowMapper.persistedStateToRows），
  // 此处把历史脏行一次性回填为真实活动时间（空 entries 兑底 created_at）。
  // 幂等：已修好的行不满足 WHERE（IS NOT 处理 NULL 三值比较），重跑零写；
  // 表不存在（新库——随后 SCHEMA_SQL 直建）= 无需回填。
  if (tableColumns(db, "session_state").length > 0) {
    db.exec(
      "UPDATE session_state SET updated_at = COALESCE(json_extract(entries, '$[#-1].createdAt'), created_at) " +
        "WHERE updated_at IS NOT COALESCE(json_extract(entries, '$[#-1].createdAt'), created_at)",
    );
  }
}

/** 列存在性（表不存在视为"无需演进"——随后的 CREATE TABLE 直建新形状）。 */
function hasColumn(db: Database, table: string, column: string): boolean {
  const cols = tableColumns(db, table);
  return cols.length === 0 || cols.includes(column);
}

/**
 * legacy default_model 单行表 → runtime_config KV 一次性数据迁移（P1 T1，
 * 决策 D1：独占单行表改通用 KV；构造期守护执行，与 ensureSchemaEvolved
 * 同族——SQL 内表→表数据迁移先例 agent_lifecycle PK 重建）。
 *
 * 规则（幂等）：旧表存在 → 拷贝（旧表有值且 KV 无 default_model 键时）后
 * drop 旧表；旧表不存在（新库/已迁移）→ no-op。事务包裹：拷贝+drop 同
 * 生共死，崩溃重开重试不双写（KV 有键即跳过拷贝）。选 drop 不选保留：
 * 表已出 SCHEMA_SQL，保留即孤儿双源；drop 后幂等性结构化（表不在 = 迁完）。
 */
export function migrateLegacyDefaultModel(db: Database): void {
  const legacyTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'default_model'")
    .get();
  if (legacyTable === null) return; // 新库/已迁移：no-op
  db.exec("BEGIN IMMEDIATE");
  try {
    const legacy = db.prepare("SELECT model FROM default_model WHERE id = 1").get() as
      | { model: string }
      | null;
    const kv = db.prepare("SELECT value FROM runtime_config WHERE key = 'default_model'").get() as
      | { value: string }
      | null;
    if (legacy !== null && kv === null) {
      db.prepare("INSERT INTO runtime_config (key, value) VALUES ('default_model', ?)").run(
        legacy.model,
      );
    }
    db.exec("DROP TABLE default_model");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error; // 迁移失败快速失败：daemon 不带病启动（与 ensureSchemaEvolved 同调）
  }
}

function tableColumns(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}
