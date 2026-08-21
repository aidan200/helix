/**
 * dispatcher —— 事件消费者注册表（AD-3 前端形态；architecture.md §3.4；
 * C2 拆分 T1.1；v0.2 接线 T3.1）。
 *
 * 两层结构：
 * - 注册表（本文件）：event.type → 已注册消费者 handler（register(type →
 *   handler) 形态）。会话 store 级消费者（五族 + model/history）操作活跃
 *   SessionState；清单族（directory）为拓扑级消费者（操作 TopologyState，
 *   经 dispatcher/frame.ts 路由前置判定，不入本注册表）。
 * - 帧入口（dispatcher/frame.ts）：v0.2 统一信封解析（sessionId/channel/
 *   type）→ 按 sessionId 路由（活跃完整 store / 后台轻量 store / 系统帧）
 *   → 按 type 交本注册表 / directory 消费者。
 * 未注册 type 由调用方保持原状态（原 applyEvent default 分支语义）。
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
import { applyHistoryEvent, HISTORY_EVENT_TYPES } from "../consumers/history";
import { applyModelChangedEvent, MODEL_EVENT_TYPES } from "../consumers/model";

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

// ── v0.2 新增事件真消费（T3.1 接线；替换 T1.1/T2.2 no-op 占位）──
// model.changed：会话 model 态（活跃 store 徽标数据源）
register({ types: MODEL_EVENT_TYPES, apply: applyModelChangedEvent });
// session.loadHistory.result：历史前插 + 翻页位（仅活跃会话路由至此）
register({ types: HISTORY_EVENT_TYPES, apply: applyHistoryEvent });
// session.list.result / session.list_changed：拓扑级清单消费者
// （consumers/directory.ts，操作 TopologyState——经 dispatcher/frame.ts
// 的 isDirectoryEventType 前置路由，不入本注册表；「EVENT_TYPES 全类型
// 已消费」守护 = route(type) ?? isDirectoryEventType(type)，见
// dispatcher.test.ts / frame-dispatch.test.ts）。

// ── model/auth 9 类 *.result（T2.3-result-frames 微批占位 → T3.3 真消费）──
// 拓扑级前置路由（consumers/model-config.ts，操作 TopologyState.modelConfig
// ——P-3/P-4 数据源；目录/凭据/默认为全局数据，不入活跃会话 store）。「EVENT_TYPES
// 全类型已路由」守护扩展 = route(type) ?? isDirectoryEventType(type) ??
// isModelConfigEventType(type)（dispatcher.test.ts）。本注册表不再持有
// 9 类占位（no-op 注册会拦截前置路由之后的语义路径，占位已由真消费取代）。

// ── v0.4 trace 族 + agent 执行上下文面（T2.1 契约 v0.4 no-op 占位；T1.2 先例，
//    T2.2 TracePage 接真消费，architecture.md §3.4）──
// trace.query.result：连接私有读面（点对点结果帧），真消费归 TracePage 查询链
// （shared/api transport 一次性查询，不建会话 store 副本）；agent.instantiated /
// agent.model.changed 只落盘不广播（daemon DtoMapper 零 case），正常路径不可达。
// 注册仅保「EVENT_TYPES 全类型已路由」守护绿，主 reducer 原状态返回。
register({
  types: ["trace.query.result", "agent.instantiated", "agent.model.changed"],
  apply: (s) => s,
});

// ── v0.6 agent.config 族（M6 T3；TR-AD-21 no-op 占位先例）──
// agent.config.changed：拓扑级前置路由（consumers/agent-config.ts，占位 no-op
// ——T4 智能体页接真消费），不入本注册表（同 directory/model-config 面纱）。
// 两结果帧（list.result / set_enabled.result）：点对点回执，真消费归 T4 页面
// 查询/写链（trace.query.result 先例），此处 no-op 占位保「EVENT_TYPES 全类型
// 已路由」守护绿，主 reducer 原状态返回。
register({
  types: ["agent.config.list.result", "agent.config.set_enabled.result"],
  apply: (s) => s,
});
