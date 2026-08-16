/**
 * 模型目录 DTO（v0.2 新增，契约 C §1.2；AD-2 模型模块）。
 *
 * pi-ai Model 的防腐映射（TR-AD-7 三域边界内合法：daemon 经
 * `@earendil-works/pi-ai/providers/all` 合并 builtin 静态表 + pi.dev overlay，
 * 协议侧只登记前端消费面）。daemon 侧目录合并/缓存/刷新由 T2.3 落地。
 */

/** 目录模型条目（model.catalog / model.catalog_refresh 响应载荷元素） */
export interface CatalogModel {
  /** "provider/model-id" 完整 id */
  id: string;
  providerId: string;
  /** tokens */
  contextWindow: number;
  /** 四费率（$ / 1M tokens，沿 pi-ai ModelCostRates 字段结构） */
  cost: CatalogModelCostRates;
  /** 静态表 or pi.dev overlay */
  source: "builtin" | "overlay";
}

/** 四费率（$ / 1M tokens；input/output/cacheRead/cacheWrite） */
export interface CatalogModelCostRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
