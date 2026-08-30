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
import {
  applyThinkingLevelEvent,
  THINKING_LEVEL_EVENT_TYPES,
} from "../consumers/thinking-level";

// ── v0.6 agent.config 族（M6 T4 真消费）：拓扑级前置路由（consumers/agent-config.ts）──
// changed → agentConfig.revision 失效重拉信号；两结果帧拓扑级直通（真消费归
// 页面查询链）。「EVENT_TYPES 全类型已路由」守护扩展 = route(type) ??
// isDirectoryEventType(type) ?? isModelConfigEventType(type) ??
// isAgentConfigEventType(type)（dispatcher.test.ts）。

// ── v0.7 web 族（T4 联网状态图标）：拓扑级前置路由（consumers/web-status.ts）──
// status.result/status.changed → topology.webStatus 写入（IconRail 数据源）；
// stop.result 直通。守护再扩展 ?? isWebEventType(type)（dispatcher.test.ts）。

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
// thinking.changed（thinking 批①，T2.1）：会话 thinking 切片（override/
// effective 双位；活跃 store 滑块/trigger 数据源）——model.changed 同构先例
register({ types: THINKING_LEVEL_EVENT_TYPES, apply: applyThinkingLevelEvent });
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

// ── kg 族六 *.result + kg-bootstrap 批五 *.result（iter-20260825-11fo T5.4 +
//    iter-20260829-ys7q T3.2；连接私有读面）──
// 点对点回执帧（O-6 零推送事件），真消费归 P-1 图谱页页面查询链
//（SessionContext 转发层 kgListeners——trace.query.result 先例，
// dispatcher 侧保持 no-op 注册守护绿，会话 store 零写入）。T3.2 五回执
//（bootstrap.create/produce + node.update/supersede + bootstrap.impact）
// 同规：真消费归 /project 页 bootstrap 入口卡与产出呈现而组件听众。
register({
  types: [
    "kg.projects.result",
    "kg.list.result",
    "kg.node.detail.result",
    "kg.change.report.result",
    "kg.node.confirm.result",
    "kg.index.status.result",
    "kg.bootstrap.create.result",
    "kg.bootstrap.produce.result",
    "kg.node.update.result",
    "kg.node.supersede.result",
    "kg.bootstrap.impact.result",
    // C1 kg 维护批两回执（purge / index.delete）——同规：真消费归 /project
    // 页 kg-head 与索引面板组件听众，no-op 注册保守护绿
    "kg.graph.purge.result",
    "kg.index.delete.result",
    // W2-E 体检看板 + W2-F 评审批回执——同规：真消费归 /project 页体检面板
    // 组件听众（KgViewer 常驻 listener 单飞关联），no-op 注册保守护绿
    "kg.health.result",
    "kg.review.create.result",
  ],
  apply: (s) => s,
});

// ── workspace 族（W3 门禁读/写面 + W4 changed 广播；连接私有回执/广播）──
// workspace.get.result / workspace.open.result 点对点回执与 workspace_changed
// 广播，真消费归 entities/workspace 门禁状态机（SessionContext 转发层
// workspaceListeners——kg 族先例）与 W4 各域刷新链（ProjectPage/会话清单
// 重拉，经同转发层订阅）；no-op 注册保「EVENT_TYPES 全类型已路由」守护绿，
// 会话 store 零写入。W4 豁免全清：changed 广播正式登记。
register({
  types: ["workspace.get.result", "workspace.open.result", "workspace_changed"],
  apply: (s) => s,
});

// ── task 族（task 批，iter-20260829-ys7q T1.5；task.changed 逐迁移广播）──
// 任务页 P-2 连接私有读面：真消费归 entities/tasks 页面 reducer（T3.1
// tasks-model 听众——connection 面听众转发模式，kg 族先例）；此处 no-op
// 注册保「EVENT_TYPES 全类型已路由」守护绿，会话 store 零写入（任务非
// 会话维——帧经 notification 通道 daemon 级下发）。
register({
  types: ["task.changed"],
  apply: (s) => s,
});

// ── v0.6 agent.config 族（M6 T4 真消费收口）──
// 三 type（changed 广播 + 两点对点结果帧）全走拓扑级前置门
// （consumers/agent-config.ts，dispatcher/frame.ts ⓪′）：changed 接真消费
// （agentConfig.revision 失效重拉信号），两结果帧拓扑级直通（真消费归
// 页面查询链，SessionContext 转发层——trace.query.result 先例；T3 遗留②：
// 本注册表的 no-op 占位已注销，不入会话 store 面）。
