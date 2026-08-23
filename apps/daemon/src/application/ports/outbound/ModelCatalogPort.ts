/**
 * 目录拉取出站端口（outbound，TR-AD-2：outbound = 目录拉取 / auth.json /
 * 默认模型存储）。pi.dev overlay 拉取 + builtin 静态表合并的实现体在
 * driven（adapters/driven/pi-engine/model-catalog.ts——pi-ai import 只允许
 * 出现在 driven 域，AG-04）；本文件只登记 application 消费面
 * （类型镜像，不 import 协议包——port 铁律 AG-01）。
 */

/** 目录模型条目（协议 CatalogModel 的 domain 侧镜像；四费率 $/1M tokens）。 */
export interface CatalogModelView {
  /** "provider/model-id" 完整 id */
  readonly id: string;
  readonly providerId: string;
  readonly contextWindow: number;
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
  /** 静态表 or pi.dev overlay */
  readonly source: "builtin" | "overlay";
  /**
   * pi-ai Model.reasoning 防腐映射（thinking 批②，AD-4②）：false → UI 禁用
   * 推理控件（TR-AD-42：前端不自判能力）。
   */
  readonly reasoning: boolean;
  /**
   * pi-ai thinkingLevelMap 非 null 键集派生的升序档序列（canonical 序取自
   * pi-ai getSupportedThinkingLevels——档位 SoT 在 pi-ai，helix 不维护第二份
   * 枚举，AD-2；剔除 "off"——helix 不引入 off 语义）；reasoning=false → 空数组。
   */
  readonly thinkingLevels: readonly string[];
}

/** 目录快照（model.catalog / catalog_refresh 结果载荷镜像）。 */
export interface CatalogSnapshot {
  readonly models: readonly CatalogModelView[];
  /** 上次远端核对时间（epoch ms；无 overlay 历史 → 0） */
  readonly refreshedAt: number;
  /** 本快照数据来源：远端确认 / 落盘缓存 / 纯 builtin */
  readonly source: "cache" | "builtin" | "remote";
}

/** 连通验证结果（auth.verify：不缓存，每次真实请求）。 */
export type AuthVerifyOutcome =
  | { readonly status: "ok"; readonly latencyMs: number }
  | { readonly status: "fail"; readonly reason: string };

export interface ModelCatalogPort {
  /**
   * 目录读面（4h 缓存口径）：overlay 缓存过期时先对 pi.dev 做条件刷新
   * （ETag 304 只挪 checkedAt）；离线/失败保缓存降级 builtin，不抛错。
   */
  catalog(): Promise<CatalogSnapshot>;
  /**
   * 手动强制刷新（绕过 4h 缓存口径）：逐 provider 并发拉 pi.dev；
   * 单 provider 失败保其缓存，全部失败 → 快照仍可用（degraded 列明细）。
   */
  refresh(): Promise<CatalogSnapshot & { readonly degraded: readonly string[] }>;
  /** "provider/model-id" 是否在合并目录中（model.set / set_default 校验面）。 */
  hasModel(modelId: string): boolean;
  /** 合并目录的 provider id 全集（auth.* 的 provider 校验面）。 */
  providerIds(): readonly string[];
  /** 连通验证（最小 completion 请求；实现定稿：pi-ai streamSimple maxTokens=1）。 */
  verify(providerId: string, apiKey: string | undefined): Promise<AuthVerifyOutcome>;
}
