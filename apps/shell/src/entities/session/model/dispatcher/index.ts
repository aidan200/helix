/**
 * dispatcher —— 事件消费者注册表骨架（AD-3 前端形态；architecture.md §3.4；
 * C2 拆分 T1.1）。
 *
 * 纯映射：event.type → 已注册消费者 handler（register(type → handler) 形态，
 * brief 决策消解的机械判据）。本任务只搭壳——不接 WS 帧（帧 → sessionId
 * 路由 → store 分发归 T3.1 接线），也不做多会话 store 拓扑（stores/ 归 T3.1）。
 * 未注册 type 由调用方保持原状态（原 applyEvent default 分支语义）。
 * v0.2 新增 session.list_changed / model.changed 预埋 no-op 占位消费者
 * （守护不变量「EVENT_TYPES 全类型已路由」；真实消费接线归 T3.1）。
 * 纯函数纪律（AG-14）：无 React / 无 IO / 无 Date.now。
 */
import type { EventEnvelope } from "@helix/protocol";
import type { SessionState } from "../state";
import { applyConnEvent, CONN_EVENT_TYPES } from "../consumers/conn";
import { applyChatEvent, CHAT_EVENT_TYPES } from "../consumers/chat";
import { applyAgentEvent, AGENT_EVENT_TYPES } from "../consumers/agent";
import {
  applyThinkingUsageEvent,
  THINKING_USAGE_EVENT_TYPES,
} from "../consumers/thinking-usage";
import { applySnapshotEvent, SNAPSHOT_EVENT_TYPES } from "../consumers/snapshot";

/** 消费者事件处理面（帧驱动；ts 由 provider 注入保持 reducer 纯）。 */
export type SessionEventHandler = (
  s: SessionState,
  event: EventEnvelope,
  ts?: number,
) => SessionState;

/** 消费者注册面：本族事件 type 清单 + 处理函数（AD-3 消费者注册表形态）。 */
export interface EventConsumer {
  types: readonly string[];
  apply: SessionEventHandler;
}

const registry = new Map<string, SessionEventHandler>();

/** 登记消费者（同 type 后注册覆盖先注册；注册表唯一写入口）。 */
export function register(consumer: EventConsumer): void {
  for (const type of consumer.types) registry.set(type, consumer.apply);
}

/** 按 type 查消费者；未注册返回 undefined（调用方保持原状态）。 */
export function route(type: string): SessionEventHandler | undefined {
  return registry.get(type);
}

// ── 注册表装配（模块加载即登记；五块消费者按族注册）──────────
// conn：帧驱动 connection.*（conn 语义归 conn 块，定稿见 consumers/conn.ts 头注）
register({ types: CONN_EVENT_TYPES, apply: applyConnEvent });
register({ types: CHAT_EVENT_TYPES, apply: applyChatEvent });
register({ types: AGENT_EVENT_TYPES, apply: applyAgentEvent });
register({ types: THINKING_USAGE_EVENT_TYPES, apply: applyThinkingUsageEvent });
register({ types: SNAPSHOT_EVENT_TYPES, apply: applySnapshotEvent });

// ── v0.2 新增事件占位（session 族结果/通知；T3.1 接线）──
// no-op 占位消费者：保持原状态（与未注册 type 的 default 语义一致），仅维持
// 「EVENT_TYPES 全类型已路由」守护不变量；会话清单投影 / 换模生效 UI 消费
// 归 T3.1 接线实现（届时替换为真消费者，勿删占位以外的守护面）。
// T2.2 新增 session.list.result / session.loadHistory.result（命令结果点对点
// 回执，daemon 侧已落地；前端消费随 T3.1/T3.2 接线）。
register({
  types: [
    "session.list_changed",
    "model.changed",
    "session.list.result",
    "session.loadHistory.result",
  ],
  apply: (s) => s,
});
