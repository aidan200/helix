/**
 * P-3 模型菜单可用性过滤——barrel 单源面（体量门同款拆面定式）。
 *
 * 实现体已上移 shared/lib/model-availability.ts（运行期化批：AG-15 FSD
 * 同层禁互引——features/steward 面板临时切换条复用同一过滤，跨 feature
 * 引用违规，纯函数上移 shared 后两消费面同源）；本地 re-export 保持既有
 * 导入路径（P-3 菜单 / AgentPage / 本目录测试）零消费方改动。
 */
export { filterAvailableModels, resolveCatalogMatch, sameModel } from "@/shared/lib/model-availability";
export type { AvailabilityFilterInput } from "@/shared/lib/model-availability";
