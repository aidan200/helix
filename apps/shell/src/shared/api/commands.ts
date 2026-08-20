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
  AuthDeleteKeyCommand,
  AuthListCommand,
  AuthSetKeyCommand,
  AuthVerifyCommand,
  ChatAbortCommand,
  ChatSendCommand,
  ChatSteerCommand,
  ModelCatalogCommand,
  ModelCatalogRefreshCommand,
  ModelGetDefaultCommand,
  ModelSetCommand,
  ModelSetDefaultCommand,
  SessionDeleteCommand,
  SessionListCommand,
  SessionLoadHistoryCommand,
  SessionSubscribeCommand,
  SessionUnsubscribeCommand,
  TraceQueryCommand,
  TraceQueryPayload,
} from "@helix/protocol";

/** chat.send：既有会话发送（信封 sessionId = 活跃会话）。 */
export function chatSendCommand(text: string, sessionId: string): ChatSendCommand {
  return { v: PROTOCOL_VERSION, type: "chat.send", sessionId, payload: { text } };
}

/** chat.send 草稿首条消息：无信封 sessionId + draft:true（契约 B §1.5）。
 *  T3（bug4）：model 可选——仅非空时携带（ChatSendPayload.model?，仅
 *  draft:true 建会话链消费；缺省 = 全局默认不换模）。 */
export function chatSendDraftCommand(text: string, model?: string): ChatSendCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "chat.send",
    payload: model === undefined ? { text, draft: true } : { text, draft: true, model },
  };
}

/** chat.steer：生成中注入（信封 sessionId = 活跃会话）。v0.3（契约 §3.1，
 *  CL-3）：instanceId 可选——携带 = 定向寻址目标 SubAgent 实例（抽屉 steer
 *  输入栏）；缺省 = 主实例（主 Composer 既有语义零变更，payload 不携带 key）。 */
export function chatSteerCommand(text: string, sessionId: string, instanceId?: string): ChatSteerCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "chat.steer",
    sessionId,
    payload: instanceId === undefined ? { text } : { text, instanceId },
  };
}

/** chat.abort：中断当前生成（信封 sessionId = 活跃会话）。 */
export function chatAbortCommand(sessionId: string): ChatAbortCommand {
  return { v: PROTOCOL_VERSION, type: "chat.abort", sessionId, payload: {} };
}

/** session.subscribe：切换/建连订阅（信封 sessionId 必填；daemon 重推该会话全量快照 = ack，
 *  契约 v0.3 §2.1）。v0.3 扩 tier：缺省 full（既有语义不变）；monitor = 白名单 3 事件档。 */
export function sessionSubscribeCommand(
  sessionId: string,
  tier?: "full" | "monitor",
): SessionSubscribeCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "session.subscribe",
    sessionId,
    payload: tier === undefined ? {} : { tier },
  };
}

/** session.unsubscribe：退订（与 subscribe 同一目标会话解析规则，契约 B §1.2）。 */
export function sessionUnsubscribeCommand(sessionId: string): SessionUnsubscribeCommand {
  return { v: PROTOCOL_VERSION, type: "session.unsubscribe", sessionId, payload: {} };
}

/** session.list：全局命令（无信封 sessionId；结果 = session.list.result 点对点回推）。 */
export function sessionListCommand(): SessionListCommand {
  return { v: PROTOCOL_VERSION, type: "session.list", payload: {} };
}

/** session.delete（Q-4④）：信封 sessionId 必填；daemon 取消全部执行 → 删库 →
 *  广播 session.list_changed{deleted}（前端零权威：卡片移除由事件驱动）。 */
export function sessionDeleteCommand(sessionId: string): SessionDeleteCommand {
  return { v: PROTOCOL_VERSION, type: "session.delete", sessionId, payload: {} };
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

// ── model / auth 命令族（契约 C §1；T3.3 P-3/P-4）────────

/** model.set：运行期切换（P-3 选中即切；信封 sessionId 必填，下一 turn 生效）。 */
export function modelSetCommand(model: string, sessionId: string): ModelSetCommand {
  return { v: PROTOCOL_VERSION, type: "model.set", sessionId, payload: { model } };
}

/** model.catalog：目录快照（全局命令，4h 缓存口径；P-3 打开 / P-4 进入拉取）。 */
export function modelCatalogCommand(): ModelCatalogCommand {
  return { v: PROTOCOL_VERSION, type: "model.catalog", payload: {} };
}

/** model.catalog_refresh：绕过 4h 缓存强制拉 pi.dev（P-4 刷新按钮）。 */
export function modelCatalogRefreshCommand(): ModelCatalogRefreshCommand {
  return { v: PROTOCOL_VERSION, type: "model.catalog_refresh", payload: {} };
}

/** model.get_default：全局默认读面（全局命令；P-3 DEFAULT 徽标 / 重置入口数据源）。 */
export function modelGetDefaultCommand(): ModelGetDefaultCommand {
  return { v: PROTOCOL_VERSION, type: "model.get_default", payload: {} };
}

/** model.set_default：写全局默认（全局命令；P-4 选择器）。 */
export function modelSetDefaultCommand(model: string): ModelSetDefaultCommand {
  return { v: PROTOCOL_VERSION, type: "model.set_default", payload: { model } };
}

/** auth.list：provider 凭据清单（全局命令；P-4 列表数据）。 */
export function authListCommand(): AuthListCommand {
  return { v: PROTOCOL_VERSION, type: "auth.list", payload: {} };
}

/** auth.set_key：写 ~/.helix/auth.json（全局命令；P-4 key 弹层保存）。 */
export function authSetKeyCommand(providerId: string, apiKey: string): AuthSetKeyCommand {
  return { v: PROTOCOL_VERSION, type: "auth.set_key", payload: { providerId, apiKey } };
}

/** auth.delete_key：删 key（全局命令；P-4 两段式删除二击）。 */
export function authDeleteKeyCommand(providerId: string): AuthDeleteKeyCommand {
  return { v: PROTOCOL_VERSION, type: "auth.delete_key", payload: { providerId } };
}

/** auth.verify：连通验证（全局命令；P-4 测试连通）。 */
export function authVerifyCommand(providerId: string): AuthVerifyCommand {
  return { v: PROTOCOL_VERSION, type: "auth.verify", payload: { providerId } };
}

// ── trace 命令族（契约 v0.4 §1；T2.2 P-1 TracePage）────────

/** trace.query：会话历史事件查询（连接私有读面；信封 sessionId 位不消费，
 *  目标会话在 payload.sessionId；结果 = trace.query.result 点对点回执）。 */
export function traceQueryCommand(payload: TraceQueryPayload): TraceQueryCommand {
  return { v: PROTOCOL_VERSION, type: "trace.query", payload };
}
