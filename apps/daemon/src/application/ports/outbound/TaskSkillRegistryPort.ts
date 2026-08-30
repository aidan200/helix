/**
 * 任务类型 skill manifest 注册表读面（outbound，architecture §4.3/§7.1，AD-9②）。
 *
 * createTask 的类型合法性防线（① 步）：type 不在注册表 → task.type_unknown，
 * 不产 job 行。实现体（T2.3）：复用 SkillScanner 扫描 builtin 层，frontmatter
 * `task` 块经 domain/task parseTaskManifest 解析入表；无 task 块的普通技能
 * 不入表（向后兼容）；坏 manifest warning 且不入表。
 *
 * 本文件只有接口定义（AG-01）；T1.3 单测用内存 fake，T2.3 提供真实现。
 */

import type { TaskManifest } from "../../../domain/task/types";

/** 任务类型目录行（/project 入口任务说明数据源，T2.3/T3.2 消费）。 */
export interface TaskTypeInfo {
  /** 任务类型 = skill 名（如 kg-bootstrap）。 */
  readonly type: string;
  /** skill frontmatter description（人类可读任务说明）。 */
  readonly description: string;
}

export interface TaskSkillRegistryPort {
  /** 按 type 查 manifest；未收录 → null（引擎转 task.type_unknown）。 */
  getTaskType(type: string): TaskManifest | null;
  /** 全部任务类型目录（创建入口说明数据）。 */
  listTaskTypes(): readonly TaskTypeInfo[];
}
