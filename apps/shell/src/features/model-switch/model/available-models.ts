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

/**
 * 模型 id 拆分：含 "/" 时首段为 provider、余下为短 id（model-id 自身
 * 可再含 "/"，如 openrouter/anthropic/x）；无 "/" 时 provider 不可确定
 *（legacy welcome 短 id 形态——真实数据流 state.model / defaultModel /
 * CatalogModel.id 均为 "provider/model-id" 完整 id）。
 */
function splitModelId(id: string): { provider: string | undefined; shortId: string } {
  const idx = id.indexOf("/");
  if (idx <= 0 || idx === id.length - 1) return { provider: undefined, shortId: id };
  return { provider: id.slice(0, idx), shortId: id.slice(idx + 1) };
}

/**
 * 模型 id 双形态匹配（welcome 短 id / model.changed 完整 id 兼容）。
 * T5.4 provider 维度：短 id 相等为前提；两侧 provider 均可确定且不等 →
 * 跨厂商同名，不匹配（修复 P-3 选中态/默认徽标跨厂商误标）。单侧
 * provider 不可确定（legacy 短 id）时仅按短 id 命中——目录侧歧义消解
 * 归 resolveCatalogMatch（宁可不标也不错标）。
 */
export function sameModel(a: string, b: string): boolean {
  if (a === b) return true;
  const ma = splitModelId(a);
  const mb = splitModelId(b);
  if (ma.shortId === "" || ma.shortId !== mb.shortId) return false;
  if (ma.provider !== undefined && mb.provider !== undefined) return ma.provider === mb.provider;
  return true;
}

/**
 * 目录解析（T5.4）：把会话/默认模型 id 解析为唯一目录项。
 * - id 含 provider 前缀：仅命中该 provider 且短 id 相等的目录项
 *   （CatalogModel.id 协议为完整 id；无前缀时回落 m.providerId）；
 * - 短 id 无前缀（legacy welcome）：唯一命中才返回；跨厂商同名歧义 →
 *   undefined（宁可不标也不错标）；
 * - undefined / 空串 / 零命中 → undefined。
 */
export function resolveCatalogMatch(
  id: string | undefined,
  models: CatalogModel[],
): CatalogModel | undefined {
  if (id === undefined || id === "") return undefined;
  const target = splitModelId(id);
  if (target.shortId === "") return undefined;
  const hits = models.filter((m) => {
    const c = splitModelId(m.id);
    if (c.shortId !== target.shortId) return false;
    if (target.provider === undefined) return true;
    return (c.provider ?? m.providerId) === target.provider;
  });
  if (target.provider !== undefined) return hits[0];
  return hits.length === 1 ? hits[0] : undefined;
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
