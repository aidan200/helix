/**
 * history 消费者 —— loadHistory 分页结果（session.loadHistory.result；
 * 契约 B §1.3/§2.3；AD-1 向上分页；T3.1）。
 *
 * 活跃 store 级消费者（信封 sessionId = 目标会话；dispatcher 仅在目标 =
 * 活跃会话时路由至此——后台会话不发起分页）：
 * - 历史前插：entries 按时间升序前插到现有 entries 之前；
 * - 去重：已存在 id（重复下发/游标交叠）跳过——「历史前插不重复」机械判据；
 * - 翻页位推进：hasMore/nextCursor 落 store（hasMore=false 后 selectCanLoadEarlier
 *   为 false → 不再发 loadHistory 命令）。
 * 纯函数纪律（AG-14）：无 React / 无 IO / 无 Date.now。
 */
import type { EventEnvelope } from "@helix/protocol";
import type { SessionState } from "../state";

/** 本块承接的帧事件 type（dispatcher 注册面）。 */
export const HISTORY_EVENT_TYPES = ["session.loadHistory.result"] as const;

export function applyHistoryEvent(s: SessionState, event: EventEnvelope, _ts?: number): SessionState {
  switch (event.type) {
    case "session.loadHistory.result": {
      const { entries, hasMore, nextCursor } = event.payload;
      const known = new Set(s.entries.map((e) => e.id));
      const fresh = entries.filter((e) => !known.has(e.id));
      return {
        ...s,
        entries: [...fresh, ...s.entries],
        // total 沿自快照（result 不携带全量计数）；paged 置位（曾分页，胶囊
        // 加载尽后保留禁用态）
        history: { hasMore, nextCursor, loading: false, total: s.history.total, paged: true },
      };
    }
    default:
      return s;
  }
}
