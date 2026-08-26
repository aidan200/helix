/**
 * @helix/protocol — WS 协议类型包（CL-2 / W2；契约 §3–§7 全集 + v0.2 登记批）。
 *
 * daemon（ws-server adapter）与前端（shared/api）共同 import
 * 本包，仓库内不得存在平行手写协议类型（AD-8 / AG-13）。
 * 协议文档见 packages/protocol/PROTOCOL.md。
 */
export * from "./envelope";
export * from "./handshake";
export * from "./commands";
export * from "./modes";
export * from "./events/index";
export * from "./types/agent";
export * from "./types/chat";
export * from "./types/tool";
export * from "./types/session";
export * from "./types/usage";
export * from "./types/error";
export * from "./types/model";
export * from "./types/auth";
export * from "./types/trace";
export * from "./types/kg";
// 投影三域纯函数（T3.1 / CL-4：类型+行为契约）
export * from "./projection/index";
