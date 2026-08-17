/**
 * directory 消费者 —— 会话清单数据面（session.list.result /
 * session.list_changed；契约 B §1.1/§2.1/§2.3；T3.1）。
 *
 * 拓扑级消费者（操作 TopologyState 而非活跃 SessionState）：
 * - session.list.result（点对点命令结果，信封 sessionId = SYSTEM_SESSION_ID）
 *   → 清单整体替换 + 后台轻量 store 按清单播种（活跃会话除外）；
 * - session.list_changed（系统级广播：新建/删除/运行态变化/标题更新）
 *   → 清单 upsert（按 lastActivityAt 降序保序）+ 后台轻量 store 元数据同步
 *   （created 播种 / deleted 双面移除；unread 计数不受元数据同步影响）。
 *
 * 活跃会话的运行态投影归活跃完整 store（agent.state.changed 等帧驱动），
 * 清单/轻量 store 不为活跃会话播种（避免双源）。
 * 纯函数纪律（AG-14）：无 React / 无 IO / 无 Date.now。
 */
import type { EventEnvelope, SessionMeta } from "@helix/protocol";
import type { BackgroundSessionState, TopologyState } from "../state";

/** 本块承接的帧事件 type（拓扑级注册面；dispatcher/frame.ts 消费）。 */
export const SESSION_DIRECTORY_EVENT_TYPES = ["session.list.result", "session.list_changed"] as const;

export type DirectoryEventConsumer = (topo: TopologyState, frame: EventEnvelope) => TopologyState;

/** 是否清单族事件（dispatcher 路由前置判定）。 */
export function isDirectoryEventType(type: string): type is (typeof SESSION_DIRECTORY_EVENT_TYPES)[number] {
  return (SESSION_DIRECTORY_EVENT_TYPES as readonly string[]).includes(type);
}

/** SessionMeta → 轻量 store 元数据投影（unread 由既有轻量态保留）。 */
function metaOf(meta: SessionMeta, prev?: BackgroundSessionState): BackgroundSessionState {
  return {
    sessionId: meta.sessionId,
    title: meta.title,
    runState: meta.runState,
    lastActivityAt: meta.lastActivityAt,
    unread: prev?.unread ?? 0,
  };
}

/** 清单按 lastActivityAt 降序保序 upsert（F(1.2).2 最近活动排序）。 */
function upsertMeta(list: SessionMeta[], meta: SessionMeta): SessionMeta[] {
  const rest = list.filter((m) => m.sessionId !== meta.sessionId);
  return [...rest, meta].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

/** 非活跃会话的轻量 store 播种/同步（活跃会话跳过——投影归完整 store）。 */
function syncBackground(topo: TopologyState, meta: SessionMeta): Record<string, BackgroundSessionState> {
  if (topo.active.sessionId === meta.sessionId) return topo.background;
  return { ...topo.background, [meta.sessionId]: metaOf(meta, topo.background[meta.sessionId]) };
}

export function applyDirectoryEvent(topo: TopologyState, frame: EventEnvelope): TopologyState {
  switch (frame.type) {
    case "session.list.result": {
      // 清单整体替换（daemon 权威，已按 lastActivityAt 降序）；后台轻量 store
      // 按清单对齐（unread 保留；不在清单的残留轻量态一并清理——deleted 已
      // 有专帧，此处兜底防泄漏）
      const sessions = frame.payload.sessions;
      const activeId = topo.active.sessionId;
      const background: Record<string, BackgroundSessionState> = {};
      for (const meta of sessions) {
        if (meta.sessionId === activeId) continue;
        background[meta.sessionId] = metaOf(meta, topo.background[meta.sessionId]);
      }
      return { ...topo, list: sessions, background };
    }
    case "session.list_changed": {
      const { kind, sessionId, session } = frame.payload;
      if (kind === "deleted") {
        if (!sessionId) return topo;
        const background = { ...topo.background };
        delete background[sessionId];
        return { ...topo, list: topo.list.filter((m) => m.sessionId !== sessionId), background };
      }
      // created / state_changed：元数据携带才更新（列表级批量变化可省略）
      if (!session || !sessionId) return topo;
      return {
        ...topo,
        list: upsertMeta(topo.list, session),
        background: syncBackground(topo, session),
      };
    }
    default:
      return topo;
  }
}
