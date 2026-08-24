/**
 * shared/lib —— 目录模型 id 匹配基元（T2.1 上移单源：原 features/model-switch/
 * model/available-models.ts 内私有；FSD 同层禁互引（AG-15），thinking-level
 * 能力位解析与 model-switch 选中态/默认徽标共用同一匹配语义，上移 shared
 * 保持单源不复制）。
 *
 * 语义不变量（T5.4 钉死）：id 双形态匹配（welcome 短 id / model.changed 完整
 * id 兼容）+ provider 维度（跨厂商同名不误标）；目录解析歧义宁可不标也不错标。
 * 纯函数纪律（AG-14）：无 React / 无 IO。
 */
import type { CatalogModel } from "@helix/protocol";

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
