/**
 * summaryConfig —— 通用总结配置域（会话总结器独立化批①）。
 *
 * 定位：会话总结能力（标题 + 进展 + 记忆点三产物，及任务总结子功能）的配置面
 * 单点（KV 键位 + 轮次解析 + 旧键一次性迁移），照 memoryConfig.ts 单源先例。
 * 裁决（批①）：总结是平台能力不是管家私产——总结配置脱离 steward.* KV 命名域
 * 与 topic_config 单键 JSON，收编进 summary.* 通用域；管家配置零总结项。
 *
 * 键位（runtime_config KV，summary.* 命名域）：
 * - summary.enabled = "1"/"0"（三产物总开关——标题/进展/记忆点都归它；
 *   任务总结独立开关归 summary.task.enabled）；
 * - summary.everyTurns（锚点轮次间隔——标题/进展/记忆点共用节拍；
 *   缺省 3）；
 * - summary.model（总结模型槽位 "provider/model-id"；**显式配才产进展 +
 *   记忆点**——无默认纪律；标题回落链 summary.model → flash 默认）；
 * - summary.task.enabled = "1"/"0"（任务总结开关——语音播报摘要 + 感知分诊
 *   gate 共用，迁自 steward.summary.enabled）；
 * - summary.task.model（任务总结模型槽位，迁自 steward.summary.model；
 *   **无默认模型**——未配 = 任务总结面不可用回退极简终态通知）。
 *
 * 轮次语义（resolveSummaryEveryTurns 读面单点裁决——写面无前置值校验，
 * 值语义统一在读面兜底，与 memoryConfig「读面兜底」哲学一致）：
 * - 合法值 = 1-20 的正整数文本；非法（0/负/超界/非整数/非数字）→ 静默
 *   回退缺省 3 + warn 不抛错（总结绝不挡对话）；缺席/空串 = 缺省。
 *
 * 旧键迁移（migrateLegacySummaryKeys，一次性、幂等可重跑）：
 * - topic_config 单键 JSON {enabled,model,classifyEndpointId}（判官随
 *   「只出标题」降级形态退役——classifyEndpointId 无迁移目标，随旧键清理
 *   丢弃）；
 * - steward.sessionmemory.{enabled,everyturns,model}；
 * - steward.summary.{enabled,model} → summary.task.*。
 * 合流规则：summary.enabled = 任一旧开关开即开（特性族归一——开面只增不减，
 * 两旧开关皆关/缺席才关）；summary.model 保序回落（sessionmemory.model →
 *   topic_config.model——旧联合槽位回落链语义保序迁移）；新域已有值不覆盖
 * （新域优先），旧键无条件清空（空串 = 未配置态）。
 */

import type { RuntimeConfigPort } from "../ports/outbound/RuntimeConfigPort";

// ── summary.* 键位（通用总结配置域）────────────────────────────

/** 三产物总开关 KV 键（标题/进展/记忆点）。 */
export const SUMMARY_ENABLED_KEY = "summary.enabled";
/** 锚点轮次间隔 KV 键（缺省 SUMMARY_EVERY_TURNS_DEFAULT；三产物共用节拍）。 */
export const SUMMARY_EVERY_TURNS_KEY = "summary.everyTurns";
/** 总结模型槽位 KV 键（显式配才产进展+记忆点；标题回落链首位）。 */
export const SUMMARY_MODEL_KEY = "summary.model";
/** 任务总结开关 KV 键（语音播报摘要 + 感知分诊 gate）。 */
export const SUMMARY_TASK_ENABLED_KEY = "summary.task.enabled";
/** 任务总结模型槽位 KV 键（无默认模型——未配 = 任务总结面不可用）。 */
export const SUMMARY_TASK_MODEL_KEY = "summary.task.model";

// ── 轮次缺省值与边界 ─────────────────────────────────────────

/** 锚点轮次间隔缺省（对齐旧 topic 锚点节奏 1/3/6/9…）。 */
export const SUMMARY_EVERY_TURNS_DEFAULT = 3;
/** 锚点轮次间隔合法上界（下限 1 = 每轮都总结；上限 20 防配置事故久旱）。 */
export const SUMMARY_EVERY_TURNS_MAX = 20;

// ── 旧键（一次性迁移输入，迁后清空）─────────────────────────

/** 旧动态主题单键 JSON KV 键（{enabled,model,classifyEndpointId}——判官字段
 *  随判官退役丢弃，不迁移）。 */
export const LEGACY_TOPIC_CONFIG_KEY = "topic_config";
/** 旧会话进展记忆开关 KV 键。 */
export const LEGACY_STEWARD_SESSION_MEMORY_ENABLED_KEY = "steward.sessionmemory.enabled";
/** 旧会话进展记忆节流阈值 KV 键。 */
export const LEGACY_STEWARD_SESSION_MEMORY_EVERY_TURNS_KEY = "steward.sessionmemory.everyturns";
/** 旧会话进展记忆总结模型槽位 KV 键。 */
export const LEGACY_STEWARD_SESSION_MEMORY_MODEL_KEY = "steward.sessionmemory.model";
/** 旧任务总结开关 KV 键。 */
export const LEGACY_STEWARD_SUMMARY_ENABLED_KEY = "steward.summary.enabled";
/** 旧任务总结模型槽位 KV 键。 */
export const LEGACY_STEWARD_SUMMARY_MODEL_KEY = "steward.summary.model";

/** 任务总结面现态（E-250 分诊 gate 与播报摘要槽位共用读面）。 */
export interface SummaryTaskConfigState {
  /** 任务总结开关。 */
  readonly enabled: boolean;
  /** 任务总结模型槽位（null = 未配置——无默认模型）。 */
  readonly model: string | null;
}

/** 总结配置域现态（读面产物——config.get/set_summary 回执与消费方共用形状）。 */
export interface SummaryConfigState {
  /** 三产物总开关。 */
  readonly enabled: boolean;
  /** 锚点轮次间隔（生效值——非法回退后的真实取数口径）。 */
  readonly everyTurns: number;
  /** 总结模型槽位（null = 未配置——进展/记忆点不产）。 */
  readonly model: string | null;
  /** 任务总结子功能现态。 */
  readonly task: SummaryTaskConfigState;
}

/** 正整数文本解析（"5" → 5；0/负数/小数/非数字/超安全整数 → null）。 */
function parsePositiveInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** 槽位读面归一（空串/空白 = 未配置态 null）。 */
function slotOf(raw: string | undefined): string | null {
  return raw !== undefined && raw.trim() !== "" ? raw : null;
}

/**
 * 锚点轮次间隔读面解析（值语义单点裁决）：KV 原值 → 生效值。非法值静默
 * 回退缺省 3 + warn（不抛错——总结绝不挡对话）；缺席/空串 = 缺省。
 */
export function resolveSummaryEveryTurns(
  config: Pick<RuntimeConfigPort, "get">,
  warn?: (message: string) => void,
): number {
  const raw = config.get(SUMMARY_EVERY_TURNS_KEY);
  if (raw === undefined || raw.trim() === "") return SUMMARY_EVERY_TURNS_DEFAULT;
  const parsed = parsePositiveInt(raw);
  if (parsed === null || parsed > SUMMARY_EVERY_TURNS_MAX) {
    warn?.(`summary.everyTurns 非法（${raw}）——回退缺省 ${SUMMARY_EVERY_TURNS_DEFAULT}`);
    return SUMMARY_EVERY_TURNS_DEFAULT;
  }
  return parsed;
}

/** 总结配置域现态读面（五键 → 生效值；消费方单源取数口径）。 */
export function readSummaryConfig(config: Pick<RuntimeConfigPort, "get">): SummaryConfigState {
  return {
    enabled: config.get(SUMMARY_ENABLED_KEY) === "1",
    everyTurns: resolveSummaryEveryTurns(config),
    model: slotOf(config.get(SUMMARY_MODEL_KEY)),
    task: {
      enabled: config.get(SUMMARY_TASK_ENABLED_KEY) === "1",
      model: slotOf(config.get(SUMMARY_TASK_MODEL_KEY)),
    },
  };
}

/** 旧 topic_config 单键 JSON 解析（逐字段防御；判官字段不读——已退役）。 */
function parseLegacyTopicConfig(raw: string | undefined): { enabled: boolean; model: string | null } | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      enabled: parsed["enabled"] === true,
      model: typeof parsed["model"] === "string" && parsed["model"] !== "" ? parsed["model"] : null,
    };
  } catch {
    return undefined;
  }
}

/**
 * 旧键一次性迁移（幂等可重跑）：topic_config JSON + steward.sessionmemory.* +
 * steward.summary.* → summary.*。新域已有值不覆盖（新域优先），旧键无条件
 * 清空（空串 = 未配置态，memoryConfig 先例同款）。返回是否发生值迁移
 * （false = 零动作——供启动日志判据）。
 */
export async function migrateLegacySummaryKeys(config: RuntimeConfigPort): Promise<boolean> {
  let migrated = false;
  const topic = parseLegacyTopicConfig(config.get(LEGACY_TOPIC_CONFIG_KEY));
  const rawSmEnabled = config.get(LEGACY_STEWARD_SESSION_MEMORY_ENABLED_KEY);
  const rawSmTurns = config.get(LEGACY_STEWARD_SESSION_MEMORY_EVERY_TURNS_KEY);
  const rawSmModel = config.get(LEGACY_STEWARD_SESSION_MEMORY_MODEL_KEY);
  const rawTaskEnabled = config.get(LEGACY_STEWARD_SUMMARY_ENABLED_KEY);
  const rawTaskModel = config.get(LEGACY_STEWARD_SUMMARY_MODEL_KEY);
  const nonEmpty = (raw: string | undefined): string | undefined =>
    raw !== undefined && raw.trim() !== "" ? raw : undefined;

  const writeIfAbsent = async (key: string, value: string): Promise<void> => {
    const current = config.get(key);
    if (current !== undefined && current.trim() !== "") return;
    await config.set(key, value);
    migrated = true;
  };

  // summary.enabled 合流：任一旧开关开即开（特性族归一——开面只增不减）
  const legacyEnabledValues = [topic?.enabled === true ? "1" : undefined, nonEmpty(rawSmEnabled)];
  const anyLegacyEnabledSource = legacyEnabledValues.some((v) => v !== undefined);
  if (anyLegacyEnabledSource) {
    const on = topic?.enabled === true || rawSmEnabled === "1";
    await writeIfAbsent(SUMMARY_ENABLED_KEY, on ? "1" : "0");
  }
  // summary.everyTurns：旧节流阈值直迁（值语义在读面兜底）
  const smTurns = nonEmpty(rawSmTurns);
  if (smTurns !== undefined) await writeIfAbsent(SUMMARY_EVERY_TURNS_KEY, smTurns);
  // summary.model 保序回落：sessionmemory.model → topic_config.model（旧联合
  // 槽位回落链语义保序迁移）
  const smModel = nonEmpty(rawSmModel);
  const topicModel = topic?.model ?? undefined;
  const legacyModel = smModel ?? topicModel;
  if (legacyModel !== undefined) await writeIfAbsent(SUMMARY_MODEL_KEY, legacyModel);
  // summary.task.*：任务总结两键直迁
  const taskEnabled = nonEmpty(rawTaskEnabled);
  if (taskEnabled !== undefined) await writeIfAbsent(SUMMARY_TASK_ENABLED_KEY, taskEnabled);
  const taskModel = nonEmpty(rawTaskModel);
  if (taskModel !== undefined) await writeIfAbsent(SUMMARY_TASK_MODEL_KEY, taskModel);

  // 旧键无条件清空（含 topic_config 整键——classifyEndpointId 随判官退役丢弃）
  for (const legacyKey of [
    LEGACY_TOPIC_CONFIG_KEY,
    LEGACY_STEWARD_SESSION_MEMORY_ENABLED_KEY,
    LEGACY_STEWARD_SESSION_MEMORY_EVERY_TURNS_KEY,
    LEGACY_STEWARD_SESSION_MEMORY_MODEL_KEY,
    LEGACY_STEWARD_SUMMARY_ENABLED_KEY,
    LEGACY_STEWARD_SUMMARY_MODEL_KEY,
  ]) {
    const raw = config.get(legacyKey);
    if (raw !== undefined && raw !== "") await config.set(legacyKey, "");
  }
  return migrated;
}
