/**
 * 握手消息（契约 §2；F(6).2）。
 *
 * hello 为握手期专用 C→S 消息（不在命令目录内）；S→C 应答复用事件目录的
 * connection.welcome / connection.error（canonical 定义在 events.ts，
 * 此处组合为 HandshakeResponse，避免平行定义，AG-13）。
 */
import type { Envelope, PROTOCOL_VERSION } from "./envelope";
import type { ConnectionErrorEvent, ConnectionWelcomeEvent } from "./events";

/**
 * hello 载荷。protocolVersion 为字面量 0：v0 合规客户端必发 0；
 * daemon 收到 ≠0 值以 protocol.version_unsupported 拒绝（TP-CL6-5）。
 */
export interface HelloPayload {
  token: string;
  protocolVersion: typeof PROTOCOL_VERSION;
}

/** 握手请求（C→S，WS 连接建立后首帧） */
export interface HelloCommand extends Envelope<HelloPayload> {
  type: "hello";
}

/** 握手应答（S→C）：通过 = welcome（随后立即推 session.snapshot）；拒绝 = error 后 close */
export type HandshakeResponse = ConnectionWelcomeEvent | ConnectionErrorEvent;
