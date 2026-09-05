import type { EventFrame } from "../envelope";
import type { DiffChangedPayload } from "../types/diff";

/**
 * diff 域事件（T3+T4 轮次 diff 协议与 UI 闭环批；PROTOCOL-CHANGELOG.md §26）。
 *
 * diff.changed 挂既有 session 通道（不新增 Channel 值——task.changed/
 * session.plan.changed 先例口径）：信封 sessionId = 归属会话，push 按
 * per-session 订阅路由（只有订阅该会话的连接收到）。
 *
 * 通道纪律：本帧走 publishDelta 瞬态通道（EventPublisherPort 与 publish
 * 并列的双通道）——流式中间态语义，不落盘、不投影、EventStream 直推；
 * 严禁走 publish/domain 事件通道（那会触发 write-through 落盘 +
 * domain_events 行直写 + RestoreService 恢复重放，破坏内存态需求）。
 */
export interface DiffChangedEvent extends EventFrame<DiffChangedPayload> {
  channel?: "session";
  type: "diff.changed";
}
