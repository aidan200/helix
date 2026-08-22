/**
 * helix.db schema（architecture.md §5.5/§8.1；本文件只有 DDL 常量与表名，
 * **不含任何 SQLite 调用**：建库（new Database）、建表/守护式列级演进
 * （exec/ALTER）、全部写语句只在 WriteQueue.ts 内（AG-06 写点唯一）。
 * v0 建表即用（IF NOT EXISTS 幂等），不做迁移框架（迭代边界）；旧库
 * 升级的列级演进（ALTER 补列/PK 重建）由 WriteQueue 构造期守护执行。
 *
 * 表清单：
 * - domain_events：领域事件流（trace 数据面，四维可查询——session/instance/类型/时间）；
 * - session_state：会话聚合快照投影（entries/turns 贫血 JSON 行；instances/usage
 *   由领域事件流投影重建，非本表列）；
 * - agent_lifecycle：实例生命周期投影（每会话每实例一行，PK (session_id, instance_id)）；
 * - steer_queue：steer 待注入队列投影（未消费项）；
 * - tool_calls：工具调用记录投影（pending/running/completed/failed 全态，挂实例）；
 * - closure_records：实例收口记录行（O-5 任务报告本体：closure 五字段
 *   + findings JSON；每收口一行，追加重语义）；
 * - default_model：全局默认模型单行表（AD-2 auth 分层：经常变的状态不进
 *   JSON，进 SQLite；id 固定 1 行，CHECK 约束钉死单值）；
 * - resource_state：profile kind 维资源启停差异行（主键
 *   (profile_kind, resource_type, name)；缺省无记录 = 启用的语义在 service
 *   层——本表只存用户显式选择过的差异，零配置兼容现状、存量零迁移）。
 *
 * 列演进（演进史见 docs/decisions/ADR-persistence.md）：agent_instance_id / instance_id 列与复合 PK；
 * DEFAULT 'main' = 主实例固定 id，与旧行回填常量同源。
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS domain_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  agent_kind TEXT NOT NULL,
  agent_instance_id TEXT NOT NULL DEFAULT 'main',
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_domain_events_session ON domain_events(session_id);
CREATE INDEX IF NOT EXISTS idx_domain_events_agent_kind ON domain_events(agent_kind);
CREATE INDEX IF NOT EXISTS idx_domain_events_instance ON domain_events(agent_instance_id);
CREATE INDEX IF NOT EXISTS idx_domain_events_type ON domain_events(type);
CREATE INDEX IF NOT EXISTS idx_domain_events_ts ON domain_events(ts);

CREATE TABLE IF NOT EXISTS session_state (
  session_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  entries TEXT NOT NULL,
  turns TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_lifecycle (
  session_id TEXT NOT NULL,
  instance_id TEXT NOT NULL DEFAULT 'main',
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, instance_id)
);

CREATE TABLE IF NOT EXISTS steer_queue (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_steer_queue_session ON steer_queue(session_id);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  instance_id TEXT NOT NULL DEFAULT 'main',
  tool_name TEXT NOT NULL,
  args TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  error TEXT,
  images TEXT,
  started_at TEXT,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);

CREATE TABLE IF NOT EXISTS closure_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  result TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  report_path TEXT,
  findings TEXT,
  task_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_closure_records_session ON closure_records(session_id);
CREATE INDEX IF NOT EXISTS idx_closure_records_agent ON closure_records(session_id, agent_id);

CREATE TABLE IF NOT EXISTS default_model (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  model TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resource_state (
  profile_kind TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (profile_kind, resource_type, name)
);
CREATE INDEX IF NOT EXISTS idx_resource_state_kind ON resource_state(profile_kind, resource_type);
`;
