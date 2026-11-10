/**
 * thinking-level 能力位纯函数段——barrel 单源面（体量门同款拆面定式）。
 *
 * 实现体已上移 shared/lib/thinking-capability.ts（运行期化批：AG-15 FSD
 * 同层禁互引——features/steward 面板临时切换条复用能力位解析，跨 feature
 * 引用违规，纯函数上移 shared 后两消费面同源）；本地 re-export 保持既有
 * 导入路径（ComposerThinkingPicker / 本目录测试）零消费方改动。
 */
export { resolveThinkingCapability, isPeakLevel, defaultLevelFor, isClamped } from "@/shared/lib/thinking-capability";
