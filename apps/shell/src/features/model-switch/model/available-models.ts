/**
 * P-3 模型菜单可用性过滤（T5.3：全目录 → 仅可用；features/model-switch/model）。
 *
 * 口径（用户裁决，覆盖原型"全目录"规格）：
 * - provider configured join：仅保留 model.providerId 在 auth 中
 *   configured === true 的模型（verifyStatus 不参与——手动按需探测，不作
 *   过滤依据；未配置分组整体隐藏，不做弱化引导——YAGNI）；
 * - 当前会话模型兜底：当前模型无论 provider 是否 configured 都保留显示
 *   （防菜单里找不到当前项）；
 * - auth 首批未到达（authLoaded=false）不过滤（避免菜单开启瞬间误闪
 *   零可用空态）；
 * - 搜索在过滤后集合上进行（命中模型名 / provider 名）。
 * T5.4 热修：sameModel 补 provider 维度（跨厂商同名不误标）+
 * resolveCatalogMatch 目录解析（短 id 跨厂商歧义宁可不标也不错标）。
 * 纯函数纪律（AG-14）：无 React / 无 IO。
 */
import type { CatalogModel } from "@helix/protocol";
import type { AuthProviderEntry } from "@/entities/session/model/state";
import { resolveCatalogMatch, sameModel } from "@/shared/lib/catalog-match";

// 目录模型 id 匹配基元单源上移 shared/lib/catalog-match（T2.1，AG-15 FSD 同层
// 禁互引：thinking-level 能力位解析共用同一匹配语义）；本地 re-export 保持
// 既有导入路径（P-3 菜单 / AgentPage / 本目录测试）零消费方改动。
export { resolveCatalogMatch, sameModel };

export interface AvailabilityFilterInput {
  /** 合并目录全量（model.catalog 结果帧） */
  models: CatalogModel[];
  /** provider 凭据行（auth.list 结果帧） */
  auth: Record<string, AuthProviderEntry>;
  /** auth.list 首批到达标记（false = 不过滤，仅搜索） */
  authLoaded: boolean;
  /** 当前会话模型（活跃 store；undefined = 未知，无兜底项） */
  currentModel: string | undefined;
  /** 搜索词（空 = 不过滤） */
  query: string;
}

/**
 * 可用性过滤 + 搜索（返回保持目录顺序的命中子集；分组由调用方按
 * providerId 聚合，组间/组内序沿目录）。
 */
export function filterAvailableModels(input: AvailabilityFilterInput): CatalogModel[] {
  const q = input.query.trim().toLowerCase();
  // 当前会话模型兑底解析（T5.4：provider 维度 + 短 id 歧义不兑底）
  const currentHit = resolveCatalogMatch(input.currentModel, input.models);
  return input.models.filter((m) => {
    if (input.authLoaded) {
      const configured = input.auth[m.providerId]?.configured === true;
      const isCurrent = currentHit === m;
      if (!configured && !isCurrent) return false;
    }
    if (q && !m.id.toLowerCase().includes(q) && !m.providerId.toLowerCase().includes(q)) return false;
    return true;
  });
}
