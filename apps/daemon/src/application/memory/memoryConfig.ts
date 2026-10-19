/**
 * memoryConfig —— 通用记忆配置域（批B：长期记忆配置独立化）。
 *
 * 定位：长期记忆的配置面单点（KV 键位 + 召回量解析 + 旧键一次性迁移）。
 * 裁决（批B）：记忆配置脱离 steward.* KV 命名域——未来不止管家使用记忆，
 * 配置不能挂在管家名下；本模块是通用记忆配置域的唯一键位来源（与
 * EmbeddingConfigService 的 embedding_endpoints 独立域同族先例）。
 *
 * 键位（runtime_config KV，memory.* 命名域）：
 * - memory.enabled = "1"/"0"（记忆开关——记忆是可选项，零依赖开箱）；
 * - memory.endpointId（引用 embedding_endpoints 配置域条目——向量端点）；
 * - memory.judgeEndpointId（引用 kind=classifier 条目——查重精评判官）；
 * - memory.recallTopK（召回注入条数上限；缺省 5——B1 定格值降级为缺省）；
 * - memory.recallPool（召回候选池；缺省 24——同上）；
 * - memory.recallMinScore（召回资格闸阈值；缺省 STEWARD_MEMORY_RECALL_MIN_SCORE
 *   = 0.3——常量单一来源在本域，缺省回退引用不双写字面量）。
 *
 * 召回量语义（resolveMemoryRecallParams 读面单点裁决——写面无前置校验，
 * 值语义统一在读面兜底）：
 * - 合法值 = 正整数文本；pool ≤ 200（合理上界）；topK ≤ pool（配对约束）；
 * - 非法值（0/负数/非整数/非数字/超上界）→ 静默回退缺省 + warn 不抛错
 *   （召回绝不挡对话）；topK>pool 组合非法 → 整对回退缺省（5/24）；
 * - 缺席/空串 = 未配置态 → 缺省值（零行为变化）。
 *
 * 阈值语义（recallMinScore）：合法值 = [0,1] 区间有限数文本（0 = 关闸全
 * 放行；1 = 只放完美匹配）；非法值（非数/负数/>1/NaN/Infinity）→ 静默
 * 回退缺省 0.3 + warn 不抛错（同上哲学）；缺席/空串 = 未配置态 → 缺省。
 * 资格闸砍在裸相似度上（融合排序之前，E-259 资格与排序解耦语义不变）——
 * 本域只供阈值，不改闸的位置与语义。
 *
 * 旧键迁移（migrateLegacyStewardMemoryKeys，一次性、幂等可重跑）：
 * steward.memory.{enabled,endpointId,judgeEndpointId} → memory.* 同名键；
 * 新域已有值不覆盖（新域优先），旧键无条件清空（空串 = 未配置态）。
 *
 * memory.endpointId 退役（批1：全局默认 embedding 端点收编）：向量端点
 * 选择从记忆配置面删除，全 helix 恒用 embedding.defaultEndpointId（单点
 * 语义见 EmbeddingConfigService.resolveDefault）。本域保留该键位常量仅作
 * 迁移输入：migrateMemoryEndpointToDefault（一次性、幂等）把它迁为默认
 * 端点（所指条目存在 ∧ kind=embedding 才迁，否则丢弃 warn 留档）后清键。
 */

import type { RuntimeConfigPort } from "../ports/outbound/RuntimeConfigPort";
import type { EmbeddingEndpointRecord } from "../embedding/EmbeddingConfigService";
import { EMBEDDING_DEFAULT_ENDPOINT_ID_KEY } from "../embedding/EmbeddingConfigService";

// ── 召回资格闸阈值缺省（常量归属本域——评审 F1 环形依赖修复：原先定义在
//    StewardMemoryService 由本模块回引，与 StewardMemoryService → memoryConfig
//    正向引用构成环且常量落位与「配置不挂管家名下」裁决矛盾；迁入本域后
//    管家侧反向取用，StewardMemoryService 保留同名 re-export 兼容既有引用）──

/** 召回资格闸阈值缺省（bge-m3 cosine 经验值 0.30——资格闸砍在裸相似度上，
 *  融合排序之前；近似主题即可达标，纯噪音明显低于此）。 */
export const STEWARD_MEMORY_RECALL_MIN_SCORE = 0.3;

// ── memory.* 键位（通用记忆配置域）────────────────────────────────

/** 记忆开关 KV 键。 */
export const MEMORY_ENABLED_KEY = "memory.enabled";
/** 向量端点引用 KV 键（批1 起**退役**——全局默认 embedding 端点收编
 *  embedding.defaultEndpointId，全 helix 恒用默认端点；本键位仅作一次性
 *  迁移输入（migrateMemoryEndpointToDefault 迁后清空），不再有任何读面）。 */
export const MEMORY_ENDPOINT_ID_KEY = "memory.endpointId";
/** 判官端点引用 KV 键（kind=classifier 条目；未配置 = 查重精判静默不挂）。 */
export const MEMORY_JUDGE_ENDPOINT_ID_KEY = "memory.judgeEndpointId";
/** 召回注入条数上限 KV 键（缺省 MEMORY_RECALL_TOP_K_DEFAULT）。 */
export const MEMORY_RECALL_TOP_K_KEY = "memory.recallTopK";
/** 召回候选池 KV 键（缺省 MEMORY_RECALL_POOL_DEFAULT）。 */
export const MEMORY_RECALL_POOL_KEY = "memory.recallPool";
/** 召回资格闸阈值 KV 键（缺省 STEWARD_MEMORY_RECALL_MIN_SCORE——常量
 *  单一来源在本域（memoryConfig），缺省回退引用不双写字面量）。 */
export const MEMORY_RECALL_MIN_SCORE_KEY = "memory.recallMinScore";

// ── 召回量缺省值与边界（批B：常量降级为缺省——现行为零变化）────────

/** 召回 topK 缺省（B1 定格 5——system prompt 预算纪律，与对话 16k 窗口同族）。 */
export const MEMORY_RECALL_TOP_K_DEFAULT = 5;
/** 召回候选池缺省（vec0 取大池后融合重排——资格闸 0.30 不变）。 */
export const MEMORY_RECALL_POOL_DEFAULT = 24;
/** 召回候选池合理上界（超此值视为非法 → 回退缺省；防 KV 误写放大检索面）。 */
export const MEMORY_RECALL_POOL_MAX = 200;

// ── 旧键（steward.* 命名域——一次性迁移输入，迁后清空）────────────

/** 旧记忆开关 KV 键（批B 迁移输入）。 */
export const LEGACY_STEWARD_MEMORY_ENABLED_KEY = "steward.memory.enabled";
/** 旧向量端点引用 KV 键（批B 迁移输入）。 */
export const LEGACY_STEWARD_MEMORY_ENDPOINT_ID_KEY = "steward.memory.endpointId";
/** 旧判官端点引用 KV 键（批B 迁移输入）。 */
export const LEGACY_STEWARD_MEMORY_JUDGE_ENDPOINT_ID_KEY = "steward.memory.judgeEndpointId";

/** 召回量生效值（读面解析产物——非法回退后的真实取数口径）。 */
export interface MemoryRecallParams {
  /** 召回注入条数上限。 */
  readonly topK: number;
  /** 召回候选池（store.search 入参）。 */
  readonly pool: number;
  /** 召回资格闸阈值（裸相似度下限——[0,1]；0 = 关闸全放行）。 */
  readonly minScore: number;
}

/** 正整数文本解析（"5" → 5；0/负数/小数/非数字/超安全整数 → null）。 */
function parsePositiveInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** 单位区间文本解析（"0.5" → 0.5；[0,1] 外/非有限数 → null）。 */
function parseUnitInterval(raw: string): number | null {
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

/**
 * 召回量读面解析（值语义单点裁决）：KV 原值 → 生效值。非法值静默回退
 * 缺省 + warn（不抛错——召回绝不挡对话）；topK>pool 组合非法 → 整对回退
 * 缺省（5/24 恒满足配对约束，无级联）。缺席/空串 = 未配置态 → 缺省。
 */
export function resolveMemoryRecallParams(
  config: Pick<RuntimeConfigPort, "get">,
  warn?: (message: string) => void,
): MemoryRecallParams {
  let topK = MEMORY_RECALL_TOP_K_DEFAULT;
  let pool = MEMORY_RECALL_POOL_DEFAULT;
  const rawTopK = config.get(MEMORY_RECALL_TOP_K_KEY);
  if (rawTopK !== undefined && rawTopK.trim() !== "") {
    const parsed = parsePositiveInt(rawTopK);
    if (parsed === null) {
      warn?.(`memory.recallTopK 非法（${rawTopK}）——回退缺省 ${MEMORY_RECALL_TOP_K_DEFAULT}`);
    } else {
      topK = parsed;
    }
  }
  const rawPool = config.get(MEMORY_RECALL_POOL_KEY);
  if (rawPool !== undefined && rawPool.trim() !== "") {
    const parsed = parsePositiveInt(rawPool);
    if (parsed === null || parsed > MEMORY_RECALL_POOL_MAX) {
      warn?.(`memory.recallPool 非法（${rawPool}）——回退缺省 ${MEMORY_RECALL_POOL_DEFAULT}`);
    } else {
      pool = parsed;
    }
  }
  if (topK > pool) {
    warn?.(
      `memory 召回量组合非法（recallTopK ${topK} > recallPool ${pool}）——整对回退缺省 ${MEMORY_RECALL_TOP_K_DEFAULT}/${MEMORY_RECALL_POOL_DEFAULT}`,
    );
    topK = MEMORY_RECALL_TOP_K_DEFAULT;
    pool = MEMORY_RECALL_POOL_DEFAULT;
  }
  // 资格闸阈值（独立于配对约束——值域 [0,1]，非法静默回退常量缺省）
  let minScore = STEWARD_MEMORY_RECALL_MIN_SCORE;
  const rawMinScore = config.get(MEMORY_RECALL_MIN_SCORE_KEY);
  if (rawMinScore !== undefined && rawMinScore.trim() !== "") {
    const parsed = parseUnitInterval(rawMinScore);
    if (parsed === null) {
      warn?.(`memory.recallMinScore 非法（${rawMinScore}）——回退缺省 ${STEWARD_MEMORY_RECALL_MIN_SCORE}`);
    } else {
      minScore = parsed;
    }
  }
  return { topK, pool, minScore };
}

/**
 * 旧键一次性迁移（幂等可重跑）：steward.memory.* 三键 → memory.* 命名域。
 * 新域已有值不覆盖（新域优先——防迁移产物互相覆盖），旧键无条件清空
 * （空串 = 未配置态，与 EmbeddingConfigService.migrateLegacyStewardEndpoint
 * 先例同款）。返回是否发生值迁移（false = 零动作——供启动日志判据）。
 */
export async function migrateLegacyStewardMemoryKeys(config: RuntimeConfigPort): Promise<boolean> {
  const pairs: readonly (readonly [legacy: string, next: string])[] = [
    [LEGACY_STEWARD_MEMORY_ENABLED_KEY, MEMORY_ENABLED_KEY],
    [LEGACY_STEWARD_MEMORY_ENDPOINT_ID_KEY, MEMORY_ENDPOINT_ID_KEY],
    [LEGACY_STEWARD_MEMORY_JUDGE_ENDPOINT_ID_KEY, MEMORY_JUDGE_ENDPOINT_ID_KEY],
  ];
  let migrated = false;
  for (const [legacyKey, key] of pairs) {
    const legacyRaw = config.get(legacyKey);
    const legacyValue = legacyRaw !== undefined && legacyRaw.trim() !== "" ? legacyRaw : undefined;
    const current = config.get(key);
    if (legacyValue !== undefined && (current === undefined || current.trim() === "")) {
      await config.set(key, legacyValue);
      migrated = true;
    }
    if (legacyRaw !== undefined && legacyRaw !== "") {
      await config.set(legacyKey, "");
    }
  }
  return migrated;
}

/**
 * memory.endpointId 退役迁移（批1，一次性、幂等可重跑；与
 * migrateLegacyStewardMemoryKeys / migrateLegacyStewardEndpoint 同链挂载，
 * 序在两者之后——端点迁移（B1 三字段 → 首条端点 + memory.endpointId）的
 * 产物也要被本次收编）：
 *
 * - embedding.defaultEndpointId 为空 ∧ memory.endpointId 有值：所指条目
 *   存在 ∧ kind=embedding → 迁为默认端点；否则丢弃（warn 留档可手工回迁）；
 * - memory.endpointId 无条件清空（有旧值才写——二次启动零改写）。
 */
export async function migrateMemoryEndpointToDefault(
  config: RuntimeConfigPort,
  embedding: { resolveRecord(endpointId: string): EmbeddingEndpointRecord | null },
  warn?: (message: string) => void,
): Promise<"migrated" | "discarded" | "none"> {
  const raw = config.get(MEMORY_ENDPOINT_ID_KEY);
  const legacyValue = raw !== undefined && raw.trim() !== "" ? raw.trim() : undefined;
  if (legacyValue === undefined) return "none"; // 无旧值：零改写（幂等判据）
  const current = config.get(EMBEDDING_DEFAULT_ENDPOINT_ID_KEY);
  const defaultEmpty = current === undefined || current.trim() === "";
  let outcome: "migrated" | "discarded" = "discarded";
  if (!defaultEmpty) {
    warn?.(`已有默认 embedding 端点（${current!.trim()}）——memory.endpointId（${legacyValue}）丢弃不迁移`);
  } else {
    const record = embedding.resolveRecord(legacyValue);
    if (record !== null && (record.kind ?? "embedding") === "embedding") {
      await config.set(EMBEDDING_DEFAULT_ENDPOINT_ID_KEY, legacyValue);
      outcome = "migrated";
    } else {
      warn?.(`memory.endpointId 所指端点不存在或非向量端点（${legacyValue}）——丢弃，未迁为默认端点`);
    }
  }
  await config.set(MEMORY_ENDPOINT_ID_KEY, "");
  return outcome;
}
