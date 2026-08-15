/**
 * helix.db 初版 schema（architecture.md §5.5/§10-2 缺口的落地，W8 出初版）。
 *
 * 本文件只有 DDL 常量与表名——**不含任何 SQLite 调用**：建库（new Database）、
 * 建表（exec）、全部写语句只在 WriteQueue.ts 内（AG-06 写点唯一）。
 * v0 建表即用（IF NOT EXISTS 幂等），不做迁移框架（迭代边界）。
 *
 * 表清单：
 * - domain_events：领域事件流（trace 数据面，四维可查询——session/agent/类型/时间）；
 * - session_state：会话聚合快照投影（Entry 树/轮次，贫血 JSON 行）；
 * - agent_lifecycle：agent 生命周期投影（每会话最后状态）；
 * - steer_queue：steer 待注入队列投影（未消费项）；
 * - tool_calls：工具调用记录投影（pending/running/completed/failed 全态）。
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS domain_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  agent_kind TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_domain_events_session ON domain_events(session_id);
CREATE INDEX IF NOT EXISTS idx_domain_events_agent_kind ON domain_events(agent_kind);
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
  session_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
  tool_name TEXT NOT NULL,
  args TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  error TEXT,
  started_at TEXT,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
`;
