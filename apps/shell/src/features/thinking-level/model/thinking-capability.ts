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

/** P-2 开关 on 且槽位空时的默认写入档（thinking 批 T3；用户决策原话：「所有
 *  模型的推理强度默认都取中间档位，如果只有两个档位则取第一档位，最高档位
 *  默认都不选」）→ levels[Math.floor((n-1)/2)]：n=1 唯一档（无选择，例外）、
 *  n=2 低档、n=3 中位、n=4 低中位；空能力集 → undefined（不写槽位）。 */
export function defaultLevelFor(levels: readonly string[]): string | undefined {
  if (levels.length === 0) return undefined;
  return levels[Math.floor((levels.length - 1) / 2)];
}

/** 覆盖/生效分离判据（F1.3）：双位非空且不等 → 轻提示（模型能力所限）。 */
export function isClamped(override: string | null, effective: string | null): boolean {
  return override !== null && effective !== null && override !== effective;
}
