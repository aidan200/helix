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
 * 纯函数纪律（AG-14）：无 React / 无 IO。
 */
import type { CatalogModel } from "@helix/protocol";
import type { AuthProviderEntry } from "@/entities/session/model/state";

/** 模型 id 双形态匹配（welcome 短 id / model.changed 完整 id 兼容）。 */
export function sameModel(a: string, b: string): boolean {
  if (a === b) return true;
  const sa = a.split("/").pop() ?? a;
  const sb = b.split("/").pop() ?? b;
  return sa !== "" && sa === sb;
}

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
  const current = input.currentModel ?? "";
  return input.models.filter((m) => {
    if (input.authLoaded) {
      const configured = input.auth[m.providerId]?.configured === true;
      const isCurrent = current !== "" && sameModel(current, m.id);
      if (!configured && !isCurrent) return false;
    }
    if (q && !m.id.toLowerCase().includes(q) && !m.providerId.toLowerCase().includes(q)) return false;
    return true;
  });
}
