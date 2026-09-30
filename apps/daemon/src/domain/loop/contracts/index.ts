/**
 * contracts —— loop 域 L0 契约层 barrel（helix-loop Phase 0a 四层拆分）。
 *
 * 纯类型 + 常量 + 摘要辅助（零状态、零行为分支）；本层不 import 本域
 * 其他层（依赖单向：runtime→policy→kernel→contracts）。
 */
export * from "./message";
export * from "./stream";
export * from "./tool";
export * from "./pause";
export * from "./event";
export * from "./markers";
