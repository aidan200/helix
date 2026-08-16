/**
 * shared/api —— C→S 命令帧构造器（v0.2 信封；契约 A §1.1 / 契约 B §1 /
 * 契约 C §1；T3.1）。
 *
 * 全部形状直引 @helix/protocol（AG-13 两端同源；TR-TEST 纪律②——harness
 * 断言与真实发送共用本面，避免手写帧字面量漂移）。会话作用域命令的信封
 * sessionId 必填（AD-4 路由位）；全局命令（session.list / model.set_default
 * 等）省略——类型层可选、本构造器纪律保证。
 * 草稿首条消息（契约 B §1.5）：chat.send 信封省略 sessionId + payload
 * draft:true（daemon 建聚合 + 回推 list_changed{created} + 订阅切换 + 快照）。
 */
import { PROTOCOL_VERSION } from "@helix/protocol";
import type {
  ChatAbortCommand,
  ChatSendCommand,
  ChatSteerCommand,
  SessionListCommand,
  SessionLoadHistoryCommand,
  SessionSubscribeCommand,
  SessionUnsubscribeCommand,
} from "@helix/protocol";

/** chat.send：既有会话发送（信封 sessionId = 活跃会话）。 */
export function chatSendCommand(text: string, sessionId: string): ChatSendCommand {
  return { v: PROTOCOL_VERSION, type: "chat.send", sessionId, payload: { text } };
}

/** chat.send 草稿首条消息：无信封 sessionId + draft:true（契约 B §1.5）。 */
export function chatSendDraftCommand(text: string): ChatSendCommand {
  return { v: PROTOCOL_VERSION, type: "chat.send", payload: { text, draft: true } };
}

/** chat.steer：生成中注入（信封 sessionId = 活跃会话）。 */
export function chatSteerCommand(text: string, sessionId: string): ChatSteerCommand {
  return { v: PROTOCOL_VERSION, type: "chat.steer", sessionId, payload: { text } };
}

/** chat.abort：中断当前生成（信封 sessionId = 活跃会话）。 */
export function chatAbortCommand(sessionId: string): ChatAbortCommand {
  return { v: PROTOCOL_VERSION, type: "chat.abort", sessionId, payload: {} };
}

/** session.subscribe：切换/建连订阅（信封 sessionId 必填；daemon 重推该会话全量快照）。 */
export function sessionSubscribeCommand(sessionId: string): SessionSubscribeCommand {
  return { v: PROTOCOL_VERSION, type: "session.subscribe", sessionId, payload: {} };
}

/** session.unsubscribe：退订（与 subscribe 同一目标会话解析规则，契约 B §1.2）。 */
export function sessionUnsubscribeCommand(sessionId: string): SessionUnsubscribeCommand {
  return { v: PROTOCOL_VERSION, type: "session.unsubscribe", sessionId, payload: {} };
}

/** session.list：全局命令（无信封 sessionId；结果 = session.list.result 点对点回推）。 */
export function sessionListCommand(): SessionListCommand {
  return { v: PROTOCOL_VERSION, type: "session.list", payload: {} };
}

/**
 * session.loadHistory：向上分页（AD-1）。beforeEntryId = 当前最早 entry id
 * （首页 = 快照 tailStartCursor；后续 = 上一页 nextCursor）；limit 缺省 =
 * daemon 侧 G-1 分页大小（50），客户端不传。
 */
export function sessionLoadHistoryCommand(sessionId: string, beforeEntryId: string): SessionLoadHistoryCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "session.loadHistory",
    sessionId,
    payload: { beforeEntryId },
  };
}
