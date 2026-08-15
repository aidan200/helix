/**
 * @helix/protocol — WS 协议 v0 类型包（CL-2 / W2；契约 §3–§7 全集）。
 *
 * daemon（T1.6 ws-server adapter）与前端（T1.7 shared/api）共同 import
 * 本包，仓库内不得存在平行手写协议类型（AD-8 / AG-13）。
 * 协议文档见 packages/protocol/PROTOCOL.md。
 */
export * from "./envelope";
export * from "./handshake";
export * from "./commands";
export * from "./events";
export * from "./types/agent";
export * from "./types/chat";
export * from "./types/tool";
export * from "./types/session";
export * from "./types/error";
