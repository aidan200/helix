import { DomainError } from "../DomainError";
import type {
  ParamFieldSchema,
  ParamFieldType,
  ParamsSchema,
  ProjectsCardinality,
  StagePlan,
  TaskManifest,
} from "./types";

/**
 * skill manifest 解析与校验纯函数（architecture.md §4.3，AD-9②）。
 *
 * framework-free：不引 zod，paramsSchema 支持子集明确定界——
 * 字段级 { type: string|number|boolean|string[], required?: boolean }，
 * 子集外声明（嵌套对象/正则/范围/未知键）一律拒绝（schema 校验即防线）。
 *
 * AD-5 口径：confirm 字段表达「开启前一次确认」，执行全程状态机零审阅概念（见 types.ts/job.ts）。
 */

const PARAM_FIELD_TYPES: readonly ParamFieldType[] = ["string", "number", "boolean", "string[]"];
const FIELD_SCHEMA_KEYS: readonly string[] = ["type", "required"];
const STAGES_FIXED_KEYS: readonly string[] = ["strategy", "list"];
const STAGES_FREE_KEYS: readonly string[] = ["strategy"];
const TASK_BLOCK_KEYS: readonly string[] = ["paramsSchema", "stages", "confirm", "plan", "projects"];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function describeValue(v: unknown): string {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v;
}

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new DomainError(`非法 task manifest：${where} 不支持的字段 "${key}"（子集外声明）`);
    }
  }
}

function parseParamsSchema(raw: unknown): ParamsSchema {
  if (!isPlainObject(raw)) {
    throw new DomainError(`非法 task manifest：paramsSchema 必须为对象，得到 ${describeValue(raw)}`);
  }
  const schema: ParamsSchema = {};
  for (const [field, fieldRaw] of Object.entries(raw)) {
    if (!isPlainObject(fieldRaw)) {
      throw new DomainError(
        `非法 task manifest：paramsSchema.${field} 必须为对象，得到 ${describeValue(fieldRaw)}`,
      );
    }
    rejectUnknownKeys(fieldRaw, FIELD_SCHEMA_KEYS, `paramsSchema.${field}`);
    const { type } = fieldRaw as Partial<ParamFieldSchema>;
    if (typeof type !== "string" || !PARAM_FIELD_TYPES.includes(type as ParamFieldType)) {
      throw new DomainError(
        `非法 task manifest：paramsSchema.${field}.type 必须为 ${PARAM_FIELD_TYPES.join("/")}，得到 ${JSON.stringify(type)}`,
      );
    }
    const fieldSchema: ParamFieldSchema = { type: type as ParamFieldType };
    const { required } = fieldRaw as { required?: unknown };
    if (required !== undefined) {
      if (typeof required !== "boolean") {
        throw new DomainError(
          `非法 task manifest：paramsSchema.${field}.required 必须为 boolean，得到 ${describeValue(required)}`,
        );
      }
      fieldSchema.required = required;
    }
    schema[field] = fieldSchema;
  }
  return schema;
}

function parseStages(raw: unknown): TaskManifest["stages"] {
  if (!isPlainObject(raw)) {
    throw new DomainError(`非法 task manifest：stages 必须为对象，得到 ${describeValue(raw)}`);
  }
  const { strategy } = raw;
  if (strategy !== "fixed" && strategy !== "free") {
    throw new DomainError(
      `非法 task manifest：stages.strategy 必须为 fixed/free，得到 ${JSON.stringify(strategy)}`,
    );
  }
  if (strategy === "fixed") {
    rejectUnknownKeys(raw, STAGES_FIXED_KEYS, "stages");
    const { list } = raw;
    if (!Array.isArray(list) || list.length === 0) {
      throw new DomainError(`非法 task manifest：stages.list 必须为非空字符串数组`);
    }
    for (const name of list) {
      if (typeof name !== "string" || name.length === 0) {
        throw new DomainError(
          `非法 task manifest：stages.list 必须为非空字符串数组，含 ${describeValue(name)}`,
        );
      }
    }
    return { strategy: "fixed", list: list as string[] };
  }
  rejectUnknownKeys(raw, STAGES_FREE_KEYS, "stages");
  return { strategy: "free" };
}

function parseProjects(raw: unknown): ProjectsCardinality {
  if (!isPlainObject(raw)) {
    throw new DomainError(`非法 task manifest：projects 必须为 { min, max } 对象，得到 ${describeValue(raw)}`);
  }
  const { min, max } = raw;
  const validCount = (v: unknown): v is number =>
    typeof v === "number" && (v === Infinity || (Number.isInteger(v) && v >= 0));
  if (!validCount(min) || !validCount(max)) {
    throw new DomainError(
      `非法 task manifest：projects.min/max 必须为非负整数（max 可为 Infinity），得到 min=${describeValue(min)}, max=${describeValue(max)}`,
    );
  }
  if (min > max) {
    throw new DomainError(`非法 task manifest：projects 基数 min(${min}) > max(${max})`);
  }
  return { min, max };
}

function parseEnumValue<T extends string>(raw: unknown, allowed: readonly T[], field: string): T {
  if (typeof raw !== "string" || !allowed.includes(raw as T)) {
    throw new DomainError(
      `非法 task manifest：${field} 必须为 ${allowed.join("/")}，得到 ${JSON.stringify(raw)}`,
    );
  }
  return raw as T;
}

/**
 * 解析 skill frontmatter 的 task 块。
 * 无 task 块 → null（普通技能向后兼容，不算非法）；有 task 块但字段非法 → 抛 DomainError。
 */
export function parseTaskManifest(frontmatter: Record<string, unknown>): TaskManifest | null {
  const task = frontmatter["task"];
  if (task === undefined || task === null) return null;
  if (!isPlainObject(task)) {
    throw new DomainError(`非法 task manifest：task 块必须为对象，得到 ${describeValue(task)}`);
  }
  rejectUnknownKeys(task, TASK_BLOCK_KEYS, "task 块");
  return {
    paramsSchema: parseParamsSchema(task["paramsSchema"]),
    stages: parseStages(task["stages"]),
    confirm: parseEnumValue(task["confirm"], ["required", "skip"] as const, "confirm"),
    plan: parseEnumValue(task["plan"], ["enforced", "optional"] as const, "plan"),
    projects: parseProjects(task["projects"]),
  };
}

function isParamType(value: unknown, type: ParamFieldType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "string[]":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
  }
}

/**
 * createTask 参数校验（§4.3）：paramsSchema 逐字段判定 + projects 数量 ∈ [min, max]。
 * 违例抛 DomainError，message 带具体违例项。
 */
export function validateTaskParams(
  manifest: TaskManifest,
  params: Record<string, unknown>,
  projects: string[],
): void {
  if (!isPlainObject(params)) {
    throw new DomainError(`params 违例：params 必须为对象，得到 ${describeValue(params)}`);
  }
  // M2：paramsSchema 外未知键一律拒绝（对齐本文件「子集外声明一律拒绝」哲学——
  // 静默吞掉未知键会让拼错字段名的调用方误以为生效）
  const unknownKeys = Object.keys(params).filter((k) => !(k in manifest.paramsSchema));
  if (unknownKeys.length > 0) {
    throw new DomainError(
      `params 违例：存在 paramsSchema 外未知参数 ${unknownKeys.map((k) => `"${k}"`).join("、")}（未声明键一律拒绝）`,
    );
  }
  for (const [field, fieldSchema] of Object.entries(manifest.paramsSchema)) {
    const value = params[field];
    if (value === undefined) {
      if (fieldSchema.required) {
        throw new DomainError(`params 违例：缺少必填参数 "${field}"（type: ${fieldSchema.type}）`);
      }
      continue;
    }
    if (!isParamType(value, fieldSchema.type)) {
      throw new DomainError(
        `params 违例：参数 "${field}" 型错误：要求 ${fieldSchema.type}，得到 ${describeValue(value)}`,
      );
    }
  }
  if (!Array.isArray(projects) || projects.some((p) => typeof p !== "string")) {
    throw new DomainError(`params 违例：projects 必须为 string 数组，得到 ${describeValue(projects)}`);
  }
  const { min, max } = manifest.projects;
  if (projects.length < min || projects.length > max) {
    throw new DomainError(
      `params 违例：projects 数量违例（得到 ${projects.length} 个，要求 ${min} ≤ n ≤ ${max === Infinity ? "∞" : max}）`,
    );
  }
}

/**
 * 阶段计划求值（AD-9①：阶段落数据行不落代码，createTask 时插入 stage 行并冻结）。
 * fixed → 按 manifest.list 生成序号行；free → confirmedStages 必填（发起者确认列表），缺则抛 DomainError。
 */
export function resolveStagePlan(manifest: TaskManifest, confirmedStages?: string[]): StagePlan[] {
  if (manifest.stages.strategy === "fixed") {
    return manifest.stages.list.map((name, i) => ({ seq: i + 1, name }));
  }
  if (confirmedStages === undefined || confirmedStages.length === 0) {
    throw new DomainError("stages 违例：free 策略需要发起者确认的阶段列表（confirmedStages），缺失或为空");
  }
  return confirmedStages.map((name, i) => ({ seq: i + 1, name }));
}
