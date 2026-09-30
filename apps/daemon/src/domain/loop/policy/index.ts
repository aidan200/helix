/**
 * policy —— loop 域 L2 策略层 barrel（helix-loop Phase 0a 四层拆分）。
 *
 * 可插拔决策点（loop 行为的配置面）：压缩策略归位本层；PauseGate/hooks
 * 契约 Phase 4 落位（设计 §2.3）。依赖单向：policy → kernel → contracts。
 */
export * from "./Compaction";
