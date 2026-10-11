/**
 * kgConfig —— 知识库配置域（批2 WP-C §5.2；「知识库」配置组的 KV 单源）。
 *
 * 定位：kg 展面配置的键位 + 值语义单点（照 memoryConfig.ts / summaryConfig.ts
 * 单源先例，E-261 同构）。**配置组归宿纪律（D4）**：后续 kg 新增可配置项
 * 一律落「知识库」配置组 + 本域键位（config.get_kg/set_kg 命令对随之扩展），
 * 不散落他组。
 *
 * 键位（runtime_config KV，kg.* 命名域）：
 * - kg.similarityWarn（查重软警告阈值 + similarTo 连线触发线；缺省 0.80）；
 * - kg.similarityDup（疑似重复候选触发线；缺省 0.92）。
 *
 * 阈值语义（resolveKgSimilarityThresholds 读面单点裁决——写面不做前置值
 * 校验，值语义统一在读面兜底，memory.recallMinScore 同哲学）：
 * - 合法值 = [0,1] 闭区间有限数文本；非法（负/>1/非数/NaN/Infinity）→
 *   该键静默回退缺省 + warn 不抛错（查重绝不挡知识写入）；
 * - 配对约束 warn ≤ dup：warn > dup（颠倒）→ **整对**回退缺省 + warn
 *   （初值待 WP-D 聚类实测校准——设计稿 §5.2）；warn == dup 合法（dup 档
 *   触发时 warn 档同时触发，语义自洽）；
 * - 缺席/空串 = 未配置态 → 缺省对。
 */

import type { RuntimeConfigPort } from "../../ports/outbound/RuntimeConfigPort";

// ── kg.* 键位（知识库配置域）────────────────────────────────

/** 查重软警告阈值 KV 键（≥ 此相似度 → 软警告 + similarTo 连线）。 */
export const KG_SIMILARITY_WARN_KEY = "kg.similarityWarn";
/** 疑似重复阈值 KV 键（≥ 此相似度 → 额外自动落疑似重复候选）。 */
export const KG_SIMILARITY_DUP_KEY = "kg.similarityDup";

// ── 阈值缺省值（设计稿 §5.2 初值——WP-D 聚类实测后校准）──────

/** 软警告阈值缺省。 */
export const KG_SIMILARITY_WARN_DEFAULT = 0.8;
/** 疑似重复阈值缺省。 */
export const KG_SIMILARITY_DUP_DEFAULT = 0.92;

/** 查重阈值生效对（读面解析产物——查重闸与 config.get/set_kg 回执同形取数）。 */
export interface KgSimilarityThresholds {
  /** 软警告 + similarTo 连线触发线。 */
  readonly warn: number;
  /** 疑似重复候选触发线。 */
  readonly dup: number;
}

/** 配置写面部分更新（config.set_kg 载荷同形；携带项写入未携带项保留）。 */
export interface KgConfigPatch {
  readonly similarityWarn?: number;
  readonly similarityDup?: number;
}

/** 单位区间文本解析（"0.5" → 0.5；[0,1] 外/非有限数 → null）。 */
function parseUnitInterval(raw: string): number | null {
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

/**
 * 查重阈值读面解析（值语义单点裁决）：KV 原值 → 生效对。逐键非法静默
 * 回退缺省 + warn；warn > dup 颠倒 → 整对回退缺省 + warn；缺席/空串 =
 * 未配置态 → 缺省对（不抛错——查重绝不挡知识写入）。
 */
export function resolveKgSimilarityThresholds(
  config: Pick<RuntimeConfigPort, "get">,
  warn?: (message: string) => void,
): KgSimilarityThresholds {
  let warnThreshold = KG_SIMILARITY_WARN_DEFAULT;
  let dupThreshold = KG_SIMILARITY_DUP_DEFAULT;
  const rawWarn = config.get(KG_SIMILARITY_WARN_KEY);
  if (rawWarn !== undefined && rawWarn.trim() !== "") {
    const parsed = parseUnitInterval(rawWarn);
    if (parsed === null) {
      warn?.(`kg.similarityWarn 非法（${rawWarn}）——回退缺省 ${KG_SIMILARITY_WARN_DEFAULT}`);
    } else {
      warnThreshold = parsed;
    }
  }
  const rawDup = config.get(KG_SIMILARITY_DUP_KEY);
  if (rawDup !== undefined && rawDup.trim() !== "") {
    const parsed = parseUnitInterval(rawDup);
    if (parsed === null) {
      warn?.(`kg.similarityDup 非法（${rawDup}）——回退缺省 ${KG_SIMILARITY_DUP_DEFAULT}`);
    } else {
      dupThreshold = parsed;
    }
  }
  // 配对约束 warn ≤ dup：颠倒（warn > dup）→ 整对回退缺省（无级联）
  if (warnThreshold > dupThreshold) {
    warn?.(
      `kg 查重阈值组合非法（similarityWarn ${warnThreshold} > similarityDup ${dupThreshold}）——整对回退缺省 ${KG_SIMILARITY_WARN_DEFAULT}/${KG_SIMILARITY_DUP_DEFAULT}`,
    );
    warnThreshold = KG_SIMILARITY_WARN_DEFAULT;
    dupThreshold = KG_SIMILARITY_DUP_DEFAULT;
  }
  return { warn: warnThreshold, dup: dupThreshold };
}
