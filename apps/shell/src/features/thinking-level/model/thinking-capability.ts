/**
 * thinking-level 能力位纯函数段（features/thinking-level/model；thinking 批 T2.1）。
 *
 * UI 不自判模型能力（TR-AD-42）：刻度数/禁用位全部消费 CatalogModel 防腐
 * 字段；本段只承载从协议字段派生的纯展示判据。纯函数纪律（AG-14）：
 * 无 React / 无 IO。
 */
import type { CatalogModel } from "@helix/protocol";
import { resolveCatalogMatch } from "@/shared/lib/catalog-match";

/**
 * 当前会话模型能力位解析（目录解析委托 model-switch 既有 T5.4 双形态匹配
 * ——provider 维度 + 短 id 歧义宁可不标也不错标；单源复用不另写匹配逻辑）。
 * undefined = 目录未到达或模型不在目录（能力位未判明）。
 */
export function resolveThinkingCapability(
  currentModel: string,
  models: CatalogModel[] | undefined,
): CatalogModel | undefined {
  return resolveCatalogMatch(currentModel, models ?? []);
}

/** PEAK 判据（F1.4）：生效档 = 当前模型最高支持档（能力位驱动——三档模型
 *  最高档 high 同触发；levels 空 / effective null 不触发）。 */
export function isPeakLevel(levels: readonly string[], effective: string | null): boolean {
  return levels.length > 0 && effective !== null && effective === levels[levels.length - 1];
}

/** 覆盖/生效分离判据（F1.3）：双位非空且不等 → 轻提示（模型能力所限）。 */
export function isClamped(override: string | null, effective: string | null): boolean {
  return override !== null && effective !== null && override !== effective;
}
