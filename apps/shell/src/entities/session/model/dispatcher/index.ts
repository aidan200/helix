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
import { applyAskEvent, ASK_EVENT_TYPES } from "../consumers/ask";
import { applyAgentEvent, AGENT_EVENT_TYPES } from "../consumers/agent";
import {
  applyThinkingUsageEvent,
  THINKING_USAGE_EVENT_TYPES,
} from "../consumers/thinking-usage";
import { applySnapshotEvent, SNAPSHOT_EVENT_TYPES } from "../consumers/snapshot";
import { applyHistoryEvent, HISTORY_EVENT_TYPES } from "../consumers/history";
import { applyInstanceHistoryEvent, INSTANCE_HISTORY_EVENT_TYPES } from "../consumers/instance-history";
import { applyModelChangedEvent, MODEL_EVENT_TYPES } from "../consumers/model";
import {
  applyThinkingLevelEvent,
  THINKING_LEVEL_EVENT_TYPES,
} from "../consumers/thinking-level";
import { applyPlanEvent, PLAN_EVENT_TYPES } from "../consumers/plan";
import { applyDiffEvent, DIFF_EVENT_TYPES } from "../consumers/diff";

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
// ask 双帧（permission_request 批）：提权申请问答卡热态（重建权威 = 快照 pendingAsk）
register({ types: ASK_EVENT_TYPES, apply: applyAskEvent });
register({ types: AGENT_EVENT_TYPES, apply: applyAgentEvent });
register({ types: THINKING_USAGE_EVENT_TYPES, apply: applyThinkingUsageEvent });
register({ types: SNAPSHOT_EVENT_TYPES, apply: applySnapshotEvent });

// ── v0.2 新增事件真消费（T3.1 接线；替换 T1.1/T2.2 no-op 占位）──
// model.changed：会话 model 态（活跃 store 徽标数据源）
register({ types: MODEL_EVENT_TYPES, apply: applyModelChangedEvent });
// thinking.changed（thinking 批①，T2.1）：会话 thinking 切片（override/
// effective 双位；活跃 store 滑块/trigger 数据源）——model.changed 同构先例
register({ types: THINKING_LEVEL_EVENT_TYPES, apply: applyThinkingLevelEvent });
// session.plan.changed（main-session plan 批）：主会话工作台账增量面——全量帧
// 整体替换 state.plan/ledger（恢复种子面 = 快照 plan 字段，consumers/snapshot）
register({ types: PLAN_EVENT_TYPES, apply: applyPlanEvent });
// diff.changed（T3+T4 diff 批）：轮次 diff 状态面——publishDelta 瞬态广播帧
// （cleared → null / active・frozen → 载荷整体落 state.diff；daemon 内存态
// 快照不携带，无恢复种子面）
register({ types: DIFF_EVENT_TYPES, apply: applyDiffEvent });
// session.loadHistory.result：历史前插 + 翻页位（仅活跃会话路由至此）
register({ types: HISTORY_EVENT_TYPES, apply: applyHistoryEvent });
// session.instanceChannels.result：实例通道全量回填（channels 惰性化批）
register({ types: INSTANCE_HISTORY_EVENT_TYPES, apply: applyInstanceHistoryEvent });
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

// ── 连接私有回执/广播直通清单（M36 注册表化：五段 no-op 占位块收敛为单一声明式
//    清单；语义 = 路由完整性登记，会话 store 零写入）──
// 本清单事件的真消费全部在 dispatcher 之外（SessionContext 转发层听众 / 页面
// 查询链）；登记在本注册表仅以 no-op 处理函数保「EVENT_TYPES 全类型已路由」
// 守护绿（主 reducer 原状态返回 = 未注册 default 语义）。新增连接私有回执/
// 广播帧时在此追加一行即完成登记（守护测试直接核查本清单，见 dispatcher.test.ts）。
export const PASSTHROUGH_EVENT_TYPES = [
  // V3b-2 批：voice 合成流式面（chunk/done）——播放队列直接消费帧流
  // （useVoiceBroadcast/朗读队列侧消费，不经会话 store）
  "voice.synthesize.chunk",
  "voice.synthesize.done",
  "voice.synthesize.stream",
  "voice.synthesize.error",

  // helix-loop L0 批：loop.* 15 型 = loop 域事件协议上收面（L3 替换承重墙）。
  // L0 阶段 shell 无消费面（管家面板走 steward.* 协议命令）；loop 事件当前
  // 仅供 daemon 内部追踪（stewardLoopTraceBridge → domain_events）——登记
  // 直通满足「协议全部事件被消费」守卫，真消费归 L2 双工/未来 trace 视图
  "loop.run.started",
  "loop.run.finished",
  "loop.run.error",
  "loop.run.paused",
  "loop.run.resumed",
  "loop.run.interrupted",
  "loop.duplex.wake",
  "loop.turn.started",
  "loop.turn.finished",
  "loop.message.started",
  "loop.message.delta",
  "loop.message.finished",
  "loop.tool.started",
  "loop.tool.progress",
  "loop.tool.finished",
  // helix-loop L1 批：上下文压缩里程碑（追踪面帧——daemon 内部投影，shell
  // 侧无独立消费面，登记直通满足全类型路由守卫）
  "loop.context.compacted",
  // 语音输入批 V1：stt.transcribe.result = 连接私有回执（点对点），真消费归
  // Composer useVoiceInput（SessionContext 转发层 subscribeSttFrames——
  // trace.query.result 先例）
  "stt.transcribe.result",
  // 流式转写批 V3b-1：stt.stream 三帧 = 连接私有（started/interim/final
  // 点对点），真消费归 useStewardVoice 流式面（subscribeSttFrames 扩帧——
  // Composer 对流式帧零感知）
  "stt.stream.started",
  "stt.stream.interim",
  "stt.stream.final",
  // 语音播报批 V2 TTS：voice.broadcast 广播帧（仅已订阅连接收）+ 语音合成
  // 回执 = 连接私有，真消费归 useVoiceBroadcast 播放与设置页试听
  //（SessionContext 转发层 subscribeVoiceFrames——stt 先例同构）
  "voice.broadcast",
  "voice.synthesize.result",
  // 文本管家批 V2.5：steward 族四帧 = 连接私有（ask/confirm/config 点对点
  // 回执 + feed 广播仅已订阅连接收），真消费归 StewardPanel 与设置页
  //（SessionContext 转发层 subscribeStewardFrames——voice 先例同构）；
  // 流式体验批 +steward.ask.delta（增量帧，useSteward streamingText 聚合）；
  // A1 工作记忆批 +history.result/tool/thinking（回放回执 + 过程帧——
  // useSteward items 同源重建与过程行追加）；
  // 驾驶舱批 +steward.navigate（页面切换指令帧——真消费归 useStewardNavigate
  // 切页钩子，App 装配层接线 navigate+switchSession）；
  // 管家记忆 B2 +steward.memory_list.result（条目清单回执——memory_list/
  // append/update/delete 四命令共用，真消费归记忆独立页）；
  // 管家记忆 B4a 批登记 +steward.sediment_proposal，B5 静默化改名
  // +steward.memory_written（记忆落盘通知帧——真消费归 useStewardActions
  // 通知卡合流，feed 同订阅闸广播）；
  // 管家感知批 M0.5 +steward.notify（主动通知帧——分诊呈现轨载体，真
  // 消费归 StewardNotifyToast 全局 toast，feed 同订阅闸广播）
  "steward.ask.result",
  "steward.ask.delta",
  "steward.confirm.result",
  // B1 两段式确认批 +steward.action.completed（确认动作执行完成帧——点对点，
  // ConfirmStack 卡片 done 态 / useSteward 历史留痕两消费面）
  "steward.action.completed",
  "steward.feed",
  "steward.config.result",
  "steward.history.result",
  "steward.tool",
  "steward.thinking",
  "steward.navigate",
  "steward.notify",
  // 确认链路修复批 +steward.pending.snapshot（在途确认卡快照——订阅对账/
  // 跨重启清场；真消费归 useStewardActions 撤旧卡）
  "steward.pending.snapshot",
  "steward.memory_written",
  "steward.memory_list.result",
  // 表面协议地基批（M0）：surface 两帧 = 连接私有（action 指令帧定向到已
  // 注册表面连接 + registered 注册回执点对点），真消费归 useStewardNavigate
  //（verb=navigate 建议导航）与 useShellSurface（注册面）——TR-89 双登记
  //（LISTEN_SURFACE.subscribeSurfaceFrames 谓词同步）
  "surface.action",
  "surface.registered",
  // embedding 配置域（管家记忆 B2）：两帧 = 连接私有（清单回执 list/set/
  // delete 共用 + 连通回执 verify），真消费归模型页向量 tab 与管家记忆区
  // 下拉（SessionContext 转发层 subscribeEmbeddingFrames——voice 先例同构）
  "embedding.list.result",
  "embedding.verify.result",
  // 三方平台批（自定义 OpenAI 兼容 provider）：清单回执 = 连接私有（list/
  // set/delete 三命令共用），真消费归模型页三方平台 tab（SessionContext
  // 转发层 subscribeProviderFrames——embedding 先例同构）
  "provider.list.result",
  // v0.4 trace 族 + agent 执行上下文面（T2.1 契约 v0.4 占位；T1.2 先例，
  // T2.2 TracePage 接真消费，architecture.md §3.4）：trace.query.result =
  // 连接私有读面（点对点结果帧），真消费归 TracePage 查询链（shared/api
  // transport 一次性查询，不建会话 store 副本）；agent.instantiated /
  // agent.model.changed 只落盘不广播（daemon DtoMapper 零 case），正常路径不可达。
  "trace.query.result",
  "agent.instantiated",
  "agent.model.changed",
  // kg 族六 *.result + kg-bootstrap 批五 *.result（iter-20260825-11fo T5.4 +
  // iter-20260829-ys7q T3.2；连接私有读面）：点对点回执帧（O-6 零推送事件），
  // 真消费归 P-1 图谱页页面查询链（SessionContext 转发层 kgListeners——
  // trace.query.result 先例）。T3.2 五回执（bootstrap.create/produce +
  // node.update/supersede + bootstrap.impact）同规：真消费归 /project 页
  // bootstrap 入口卡与产出呈现组件听众。
  "kg.projects.result",
  "kg.list.result",
  "kg.node.detail.result",
  "kg.change.report.result",
  "kg.node.confirm.result",
  "kg.node.discard.result",
  "kg.index.status.result",
  "kg.bootstrap.create.result",
  "kg.bootstrap.produce.result",
  "kg.node.update.result",
  "kg.node.supersede.result",
  "kg.bootstrap.impact.result",
  // C1 kg 维护批两回执（purge / index.delete）——同规：真消费归 /project
  // 页 kg-head 与索引面板组件听众
  "kg.graph.purge.result",
  "kg.index.delete.result",
  // W2-E 体检看板 + W2-F 评审批回执——同规：真消费归 /project 页体检面板
  // 组件听众（KgViewer 常驻 listener 单飞关联）
  "kg.health.result",
  "kg.review.create.result",
  // code-review v1.5：code.review.create 回执——同规：真消费归体检区代码
  // 评审入口（KgViewer 常驻 listener）
  "code.review.create.result",
  // 台账读面三件套：kg.candidates.list 回执——同规：真消费归 /project 页
  // 候选台账面板（KgViewer 常驻 listener）
  "kg.candidates.list.result",
  // kg-triage 发起 + P2 自动裁决审计回执——同规：真消费归 /project 页体检面板
  "kg.triage.create.result",
  "kg.auto.audit.result",
  // diff.get.result：v0.3.1 §29 起移出本清单，真消费归 consumers/diff——回执
  // 摘要落 state.diff（会话切回 rehydrate）；文件明细仍经 SessionContext
  // 转发层 subscribeDiffFrames 归 DiffOverlay 私有 reducer，转发链不受
  // dispatcher 注册表影响（两链平行）
  // workspace 族（W3 门禁读/写面 + W4 changed 广播；连接私有回执/广播）：
  // workspace.get.result / workspace.open.result 点对点回执与 workspace_changed
  // 广播，真消费归 entities/workspace 门禁状态机（SessionContext 转发层
  // workspaceListeners——kg 族先例）与 W4 各域刷新链（ProjectPage/会话清单
  // 重拉，经同转发层订阅）。W4 豁免全清：changed 广播正式登记。
  "workspace.get.result",
  "workspace.open.result",
  "workspace_changed",
  // task 族（task 批，iter-20260829-ys7q T1.5；task.changed 逐迁移广播）：
  // 任务页 P-2 连接私有读面，真消费归 entities/tasks 页面 reducer（T3.1
  // tasks-model 听众——connection 面听众转发模式，kg 族先例）；任务非会话维
  // ——帧经 notification 通道 daemon 级下发，会话 store 零写入。
  "task.changed",
  // coord 批（U5）：coord.changed 占用协调轻通知——daemon 级广播，真消费归
  // CoordNoticeToast（SessionContext 转发层 subscribeCoordFrames，task 族
  // 先例）；会话 store 零写入（协调状态非会话维）。
  "coord.changed",
  // mcp 族（mcp 批：MCP server 标准接入；六 result + status.changed 广播）：
  // 设置页 MCP 分区连接私有读面/广播，真消费归 McpSettingsSection 域订阅
  //（SessionContext 转发层 subscribeMcpFrames——workspace/kg 族先例）；
  // 工具面生效经既有 agent.config.changed 刷新链，不在 mcp 族重复广播。
  "mcp.servers.list.result",
  "mcp.servers.add.result",
  "mcp.servers.update.result",
  "mcp.servers.remove.result",
  "mcp.servers.test.result",
  "mcp.tools.list.result",
  "mcp.status.changed",
] as const;

/** 直通处理函数（no-op）：真消费在 dispatcher 外，主 reducer 原状态返回。 */
const passthrough: SessionEventHandler = (s) => s;

register({ types: PASSTHROUGH_EVENT_TYPES, apply: passthrough });

// ── v0.6 agent.config 族（M6 T4 真消费收口）──
// 三 type（changed 广播 + 两点对点结果帧）全走拓扑级前置门
// （consumers/agent-config.ts，dispatcher/frame.ts ⓪′）：changed 接真消费
// （agentConfig.revision 失效重拉信号），两结果帧拓扑级直通（真消费归
// 页面查询链，SessionContext 转发层——trace.query.result 先例；T3 遗留②：
// 本注册表的 no-op 占位已注销，不入会话 store 面）。
