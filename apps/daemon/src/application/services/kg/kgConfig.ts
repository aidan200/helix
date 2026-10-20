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
 * - kg.similarityDup（疑似重复候选触发线；缺省 0.92）；
 * - kg.semanticTopK（语义召回轨 top-K；缺省 5）；
 * - kg.semanticMinScore（语义召回最低相似度；缺省 0.35）。
 *
 * 阈值语义（resolveKgSimilarityThresholds 读面单点裁决——写面不做前置值
 * 校验，值语义统一在读面兜底，memory.recallMinScore 同哲学）：
 * - 合法值 = [0,1] 闭区间有限数文本；非法（负/>1/非数/NaN/Infinity）→
 *   该键静默回退缺省 + warn 不抛错（查重绝不挡知识写入）；
 * - 配对约束 warn ≤ dup：warn > dup（颠倒）→ **整对**回退缺省 + warn
 *   （初值待 WP-D 聚类实测校准——设计稿 §5.2）；warn == dup 合法（dup 档
 *   触发时 warn 档同时触发，语义自洽）；
 * - 缺席/空串 = 未配置态 → 缺省对。
 *
 * 语义召回对（resolveKgSemanticRecallSettings，同哲学逐键回退 + warn）：
 * - semanticTopK 合法 = 有限整数 [1,50]（上限噪声防御）；semanticMinScore
 *   合法 = [0,1]；非法逐键回退缺省——**无配对约束**（topK/minScore 无序
 *   关系，不套 warn≤dup 整对回退；两对相互独立裁决）。
 */

import type { RuntimeConfigPort } from "../../ports/outbound/RuntimeConfigPort";
// 类型单源在端口（依赖方向：端口不 import 服务实现）——此处 re-export 保
// 既有消费面 import 路径不变。
import type { KgConfigEffective, KgConfigPatch, KgSimilarityThresholds } from "../../ports/outbound/KgConfigPort";
export type { KgConfigEffective, KgConfigPatch, KgSimilarityThresholds };

// ── kg.* 键位（知识库配置域）────────────────────────────────

/** 查重软警告阈值 KV 键（≥ 此相似度 → 软警告 + similarTo 连线）。 */
export const KG_SIMILARITY_WARN_KEY = "kg.similarityWarn";
/** 疑似重复阈值 KV 键（≥ 此相似度 → 额外自动落疑似重复候选）。 */
export const KG_SIMILARITY_DUP_KEY = "kg.similarityDup";
/** 语义召回轨 top-K KV 键（向量轨最多贡献此数命中）。 */
export const KG_SEMANTIC_TOPK_KEY = "kg.semanticTopK";
/** 语义召回最低相似度 KV 键（< 此余弦的候选不入召回）。 */
export const KG_SEMANTIC_MINSCORE_KEY = "kg.semanticMinScore";

// ── 阈值缺省值（设计稿 §5.2 初值——WP-D 聚类实测后校准）──────

/** 软警告阈值缺省。 */
export const KG_SIMILARITY_WARN_DEFAULT = 0.8;
/** 疑似重复阈值缺省。 */
export const KG_SIMILARITY_DUP_DEFAULT = 0.92;
/** 语义召回 top-K 缺省。 */
export const KG_SEMANTIC_TOPK_DEFAULT = 5;
/** 语义召回最低相似度缺省。 */
export const KG_SEMANTIC_MINSCORE_DEFAULT = 0.35;
/** semanticTopK 合法上限（噪声防御——超库容量的 K 只放大低质命中）。 */
export const KG_SEMANTIC_TOPK_MAX = 50;


/** 语义召回生效对（读面解析产物——向量轨与 config.get/set_kg 回执同形取数）。 */
export interface KgSemanticRecallSettings {
  /** 向量轨最多贡献命中数。 */
  readonly topK: number;
  /** 最低相似度（余弦）——低于此分不入召回。 */
  readonly minScore: number;
}


/** 单位区间文本解析（"0.5" → 0.5；[0,1] 外/非有限数 → null）。 */
function parseUnitInterval(raw: string): number | null {
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

/** 正整数文本解析（"5" → 5；[1,max] 外/非整/非有限数 → null）。 */
function parsePositiveInt(raw: string, max: number): number | null {
  const n = Number(raw.trim());
  return Number.isFinite(n) && Number.isInteger(n) && n >= 1 && n <= max ? n : null;
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

/**
 * 语义召回对读面解析（值语义单点裁决）：逐键非法静默回退缺省 + warn；
 * 无配对约束（topK/minScore 无序关系——不套 warn>dup 整对回退）；缺席/
 * 空串 = 未配置态 → 缺省对（不抛错——语义轨绝不阻塞注入）。
 */
export function resolveKgSemanticRecallSettings(
  config: Pick<RuntimeConfigPort, "get">,
  warn?: (message: string) => void,
): KgSemanticRecallSettings {
  let topK = KG_SEMANTIC_TOPK_DEFAULT;
  let minScore = KG_SEMANTIC_MINSCORE_DEFAULT;
  const rawTopK = config.get(KG_SEMANTIC_TOPK_KEY);
  if (rawTopK !== undefined && rawTopK.trim() !== "") {
    const parsed = parsePositiveInt(rawTopK, KG_SEMANTIC_TOPK_MAX);
    if (parsed === null) {
      warn?.(`kg.semanticTopK 非法（${rawTopK}）——回退缺省 ${KG_SEMANTIC_TOPK_DEFAULT}`);
    } else {
      topK = parsed;
    }
  }
  const rawMinScore = config.get(KG_SEMANTIC_MINSCORE_KEY);
  if (rawMinScore !== undefined && rawMinScore.trim() !== "") {
    const parsed = parseUnitInterval(rawMinScore);
    if (parsed === null) {
      warn?.(`kg.semanticMinScore 非法（${rawMinScore}）——回退缺省 ${KG_SEMANTIC_MINSCORE_DEFAULT}`);
    } else {
      minScore = parsed;
    }
  }
  return { topK, minScore };
}
