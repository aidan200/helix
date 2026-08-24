/**
 * 贫血持久化行模型（AD-17 第 4 条，architecture.md §3.5）：
 * 与 SQLite 表一一对应的纯数据形状，只被 sqlite-session 适配器与 RowMapper
 * 使用——domain 不 import 本目录（模型隔离）。
 * 富行为（充血聚合）在 domain；两者转换只在 RowMapper。
 */

/** domain_events 行（id 自增；payload/ts 为 ISO/JSON 文本）。 */
export interface DomainEventRow {
  readonly id?: number;
  readonly session_id: string;
  readonly agent_kind: string;
  /** 实例归属（旧列前时代的行由守护补列回填 'main'）。 */
  readonly agent_instance_id: string;
  readonly type: string;
  readonly payload: string;
  readonly ts: string;
}

/** session_state 行（entries/turns 为 JSON 数组文本；main_instance_id 可空——
 *  列前时代旧行 NULL = legacy "main"，T10a 方案 A 列级演进补列）。 */
export interface SessionStateRow {
  readonly session_id: string;
  readonly created_at: string;
  readonly entries: string;
  readonly turns: string;
  readonly updated_at: string;
  readonly main_instance_id: string | null;
}

/** agent_lifecycle 行（每会话每实例一行，复合 PK (session_id, instance_id)）。 */
export interface AgentLifecycleRow {
  readonly session_id: string;
  readonly instance_id: string;
  readonly state: string;
  readonly updated_at: string;
}

/** steer_queue 行（seq 即入队序；source 可空——列前时代旧行 NULL = 缺省 user 语义）。 */
export interface SteerQueueRow {
  readonly seq?: number;
  readonly session_id: string;
  readonly entry_id: string;
  readonly text: string;
  readonly source: string | null;
}

/** tool_calls 行（args 为 JSON 文本；result/error/时间可空；挂实例归属）。 */
export interface ToolCallRow {
  readonly id: string;
  readonly session_id: string;
  /** 工具调用归属实例（domain 侧 ToolCallRecord 挂 id）。 */
  readonly instance_id: string;
  readonly tool_name: string;
  readonly args: string;
  readonly status: string;
  readonly result: string | null;
  readonly error: string | null;
  /** 工具结果附带图片（下行）：data URL 数组 JSON 文本；可空。 */
  readonly images: string | null;
  readonly started_at: string | null;
  readonly ended_at: string | null;
}
