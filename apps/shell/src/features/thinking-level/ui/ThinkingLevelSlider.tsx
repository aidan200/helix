/**
 * Barrel —— ThinkingLevelSlider 已上移 @/shared/ui（运行期化批 UI 对齐：
 * features/steward 面板思考 chip 消费同一原子；FSD 同层 feature 禁互引，
 * 共用组件归 shared/ui，此处转发保 P-1/P-2 既有 import 零改动）。
 */
export { default } from "@/shared/ui/ThinkingLevelSlider";
export type { ThinkingLevelSliderProps } from "@/shared/ui/ThinkingLevelSlider";
