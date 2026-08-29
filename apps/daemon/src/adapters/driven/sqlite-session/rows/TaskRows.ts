/**
 * 任务四表贫血持久化行模型（TR-AD-14；Rows.ts 同构）：
 * 与 SQLite 表一一对应的纯数据形状，只被 sqlite-session 适配器与
 * TaskRowMapper 使用——domain 不 import 本目录（模型隔离）。
 * 富行为（状态机守卫）在 domain；两者转换只在 TaskRowMapper。
 *
 * 状态列均为哑 TEXT（无 CHECK，TR-AD-3：行模型哑、domain 聪明）；
 * params/projects/artifact 为 JSON 文本列（projects 空数组合法，AD-8）。
 */

/** job 行（id TEXT PK；params/projects JSON 文本；error 可空）。 */
export interface JobRow {
  readonly id: string;
  readonly type: string;
  readonly params: string;
  readonly projects: string;
  readonly status: string;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly error: string | null;
}

/** stage 行（PK (job_id, seq)；artifact JSON 文本可空）。 */
export interface StageRow {
  readonly job_id: string;
  readonly seq: number;
  readonly name: string;
  readonly status: string;
  readonly artifact: string | null;
  readonly updated_at: string;
}

/** batch 行（id TEXT PK；stage 物理键 = job_id + stage_seq；instance_id 可空）。 */
export interface BatchRow {
  readonly id: string;
  readonly job_id: string;
  readonly stage_seq: number;
  readonly seq: number;
  readonly scope: string;
  readonly status: string;
  readonly retry_count: number;
  readonly retry_note: string | null;
  readonly instance_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** work_item 行（PK (instance_id, seq)；note 可空）。 */
export interface WorkItemRow {
  readonly instance_id: string;
  readonly seq: number;
  readonly content: string;
  readonly status: string;
  readonly note: string | null;
  readonly updated_at: string;
}
