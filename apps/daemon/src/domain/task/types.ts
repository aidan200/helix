/**
 * 任务域类型（architecture.md §3.2/§3.3）：任务四表判别式状态 + skill manifest 数据形状。
 *
 * framework-free：零 import（AG-02/AG-04）；运行时值表与类型同源声明，
 * 供状态机/测试做机械断言（枚举值扁平化 grep 无 review/awaiting/confirm，AD-5）。
 */

/** job 状态（§3.2）：终态三值 done/failed/cancelled。 */
export const JOB_STATUSES = ["pending", "running", "paused", "done", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** stage 状态（§3.3）：pending → running → done/failed。 */
export const STAGE_STATUSES = ["pending", "running", "done", "failed"] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

/**
 * 阶段角色（A 批机械约束）：plan=编排直执备料（不收批次，产物即判据）；
 * execute=批次执行（装配→申报→派发→收口，产物须批次全收口）；
 * aggregate=编排直执聚合（不收批次，产物即判据）。缺省 execute（裸字符串声明向后兼容）。
 */
export const STAGE_KINDS = ["plan", "execute", "aggregate"] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

/** batch 状态（§3.3）：pending → running → done/failed（failed 由自动重试接管，§4.5）。 */
export const BATCH_STATUSES = ["pending", "running", "done", "failed"] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

/** work_item（实例 plan）状态（§3.2）：pending → in_progress → done/abandoned（带理由）。 */
export const WORK_ITEM_STATUSES = ["pending", "in_progress", "done", "abandoned"] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

/**
 * paramsSchema 字段级声明（AD-9② 决策消解）：仅四种基础类型 + required 可选标记。
 * 子集外声明（嵌套对象/正则/范围等）在 manifest.ts 一律拒绝；不引 zod。
 */
export type ParamFieldType = "string" | "number" | "boolean" | "string[]";

export interface ParamFieldSchema {
  type: ParamFieldType;
  required?: boolean;
}

export type ParamsSchema = Record<string, ParamFieldSchema>;

/** projects 基数（AD-8②）：manifest 声明 min/max；0..n 类型 = { min: 0, max: Infinity }。 */
export interface ProjectsCardinality {
  min: number;
  max: number;
}

/** 任务类型 skill 的 frontmatter `task` 块形状（§7.1）。 */
export interface TaskManifest {
  paramsSchema: ParamsSchema;
  /** fixed 阶段清单：裸字符串（缺省 execute）或 { name, kind? } 对象（A 批角色声明）。 */
  stages: { strategy: "fixed"; list: (string | { name: string; kind?: StageKind })[] } | { strategy: "free" };
  /** AD-5：开启前一次确认（任务内容卡）；声明 skip 则免确认。 */
  confirm: "required" | "skip";
  /** AD-6：批次实例 plan 是否强制。 */
  plan: "enforced" | "optional";
  projects: ProjectsCardinality;
}

/** 阶段计划行（createTask 时落 stage 数据行，AD-9①：阶段落数据不落代码；
 * kind 仅存 manifest 派生，不落行——行结构零迁移）。 */
export interface StagePlan {
  seq: number;
  name: string;
  kind: StageKind;
}
