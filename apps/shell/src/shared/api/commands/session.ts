/**
 * shared/api/commands/session —— session 域（会话订阅/退订、清单与删除、历史分页、实例通道读面）。
 *
 * 单源归属（E-84 修订 · 体量门 P3）：本模块 = 该域命令构造器的唯一实现
 * 位置（自 shared/api/commands.ts 按命令域机械迁出，零语义改动）；公共
 * API 面经 shared/api/commands.ts barrel 精确再导出（import 路径不变）。
 * 形状直引 @helix/protocol（AG-13）。
 */

import { PROTOCOL_VERSION } from "@helix/protocol";
import type {
  SessionDeleteCommand,
  SessionListCommand,
  SessionLoadHistoryCommand,
  SessionInstanceChannelsCommand,
  SessionSubscribeCommand,
  SessionUnsubscribeCommand,
} from "@helix/protocol";

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

/**
 * session.instanceChannels：SubAgent 实例通道历史按需拉取（channels 惰性
 * 化批）。快照只携带每通道预览条，抽屉打开实例时拉首页（beforeEntryId
 * 缺省）；翻页续拉传上一页 nextCursor。
 */
export function sessionInstanceChannelsCommand(
  sessionId: string,
  instanceId: string,
  beforeEntryId?: string,
): SessionInstanceChannelsCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "session.instanceChannels",
    sessionId,
    payload: beforeEntryId === undefined ? { instanceId } : { instanceId, beforeEntryId },
  };
}
