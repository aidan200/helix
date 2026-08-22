/**
 * @helix/common — 业务无关通用层门面（AD-1 / iter-20260821-dg90 T3.3）。
 *
 * 全依赖图最底层：零外部依赖、零 @helix/* 依赖（arch-guard AG-15 结构
 * 断言守护）；daemon 各层 / protocol / shell 均可依赖本包，本包不依赖
 * 任何 @helix/* 包与第三方包。成员准入判据 = 「换一个产品仍然成立」
 * （TR-AD-28 业务无关性纪律）。
 * utils/ 为通用纯工具位（本迭代不填充——既有 utils 不批量迁移）。
 */
export * from "./constants";
