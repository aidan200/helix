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
  AgentBasePromptGetCommand,
  AgentBasePromptGetPayload,
  AgentConfigListCommand,
  AgentConfigSetEnabledCommand,
  AgentConfigSetEnabledPayload,
  AuthDeleteKeyCommand,
  AuthListCommand,
  AuthSetKeyCommand,
  AuthVerifyCommand,
  ChatAbortCommand,
  ChatSendCommand,
  ChatSteerCommand,
  ConfigGetCompactionCommand,
  ConfigSetCompactionCommand,
  KgBootstrapCreateCommand,
  KgBootstrapCreatePayload,
  KgBootstrapImpactCommand,
  KgBootstrapImpactPayload,
  KgBootstrapProduceCommand,
  KgBootstrapProducePayload,
  KgCandidatesListCommand,
  KgCandidatesListPayload,
  KgChangeReportCommand,
  KgChangeReportPayload,
  KgGraphPurgeCommand,
  KgGraphPurgePayload,
  KgHealthCommand,
  KgHealthPayload,
  KgIndexDeleteCommand,
  KgIndexDeletePayload,
  KgIndexStatusCommand,
  KgIndexStatusPayload,
  KgListCommand,
  KgListPayload,
  KgNodeConfirmCommand,
  KgNodeConfirmPayload,
  KgNodeDetailCommand,
  KgNodeDetailPayload,
  KgNodeSupersedeCommand,
  KgNodeSupersedePayload,
  KgNodeUpdateCommand,
  KgNodeUpdatePayload,
  KgProjectsCommand,
  KgReviewCreateCommand,
  KgReviewCreatePayload,
  CodeReviewCreateCommand,
  CodeReviewCreatePayload,
  ModelCatalogCommand,
  ModelCatalogRefreshCommand,
  ModelGetDefaultCommand,
  ModelSetCommand,
  ModelSetDefaultCommand,
  ModelSetThinkingDefaultCommand,
  SessionDeleteCommand,
  SessionListCommand,
  SessionLoadHistoryCommand,
  SessionSubscribeCommand,
  SessionUnsubscribeCommand,
  TaskArtifactsCommand,
  TaskArtifactsPayload,
  TaskCancelCommand,
  TaskDeleteCommand,
  TaskDetailCommand,
  TaskDetailPayload,
  TaskListCommand,
  TaskListPayload,
  TaskPauseCommand,
  TaskResumeCommand,
  TaskSubscribeCommand,
  TaskSubscribePayload,
  TaskUnsubscribeCommand,
  TaskUnsubscribePayload,
  TraceQueryCommand,
  TraceQueryPayload,
  ThinkingSetCommand,
  WebStartCommand,
  WebStatusCommand,
  WebStopCommand,
  WorkspaceGetCommand,
  WorkspaceOpenCommand,
} from "@helix/protocol";

/** chat.send：既有会话发送（信封 sessionId = 活跃会话）。
 *  T9（v0.10）：images 可选——仅非空时携带（缺省 = 纯文本旧形态，
 *  payload 不携带 images key，additive 纪律）。 */
export function chatSendCommand(text: string, sessionId: string, images?: readonly string[]): ChatSendCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "chat.send",
    sessionId,
    payload: images === undefined ? { text } : { text, images },
  };
}

/** chat.send 草稿首条消息：无信封 sessionId + draft:true（契约 B §1.5）。
 *  T3（bug4）：model 可选——仅非空时携带（ChatSendPayload.model?，仅
 *  draft:true 建会话链消费；缺省 = 全局默认不换模）。
 *  T9（v0.10）：images 可选——三可选共存（draft + model + images）。
 *  P1 T4：mode 可选——仅非 default 携带（DEFAULT_MODE_ID 走协议缺省，
 *  减少帧噪音；建会话定格链消费，此后无写路径）。 */
export function chatSendDraftCommand(
  text: string,
  model?: string,
  images?: readonly string[],
  mode?: string,
): ChatSendCommand {
  const payload: ChatSendCommand["payload"] = { text, draft: true };
  if (model !== undefined) payload.model = model;
  if (images !== undefined) payload.images = images;
  if (mode !== undefined && mode !== "default") payload.mode = mode;
  return { v: PROTOCOL_VERSION, type: "chat.send", payload };
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

/** thinking.set：会话推理强度覆盖（thinking 批①，契约 v0.11 §17.11；T2.1
 *  P-1 滑块选档；信封 sessionId 必填，下一 turn 生效；level 字符串透传
 *  ——AD-2，helix 不校验档位；生效回执 = thinking.changed 广播）。 */
export function thinkingSetCommand(level: string, sessionId: string): ThinkingSetCommand {
  return { v: PROTOCOL_VERSION, type: "thinking.set", sessionId, payload: { level } };
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
export function modelSetThinkingDefaultCommand(level: string | null): ModelSetThinkingDefaultCommand {
  return { v: PROTOCOL_VERSION, type: "model.set_thinking_default", payload: { level } };
}

export function modelSetDefaultCommand(model: string): ModelSetDefaultCommand {
  return { v: PROTOCOL_VERSION, type: "model.set_default", payload: { model } };
}

/** config.get_compaction：压缩参数读面（全局命令）。 */
export function configGetCompactionCommand(): ConfigGetCompactionCommand {
  return { v: PROTOCOL_VERSION, type: "config.get_compaction", payload: {} };
}

/** config.set_compaction：压缩参数写面（全局命令；token 绝对值）。 */
export function configSetCompactionCommand(reserveTokens: number, keepRecentTokens: number): ConfigSetCompactionCommand {
  return { v: PROTOCOL_VERSION, type: "config.set_compaction", payload: { reserveTokens, keepRecentTokens } };
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

// ── v0.6 agent.config 命令族（M6 T4 智能体页）────────────

/** agent.config.list：资源配置读面（全局命令无信封 sessionId；缺省 =
 *  全部 kind 双块；结果 = agent.config.list.result 点对点回执）。 */
export function agentConfigListCommand(): AgentConfigListCommand {
  return { v: PROTOCOL_VERSION, type: "agent.config.list", payload: {} };
}

/** agent.config.set_enabled：资源启停/槽位写面（全局命令；回执 =
 *  set_enabled.result 点对点 + applied 时 agent.config.changed 全局广播）。 */
export function agentConfigSetEnabledCommand(payload: AgentConfigSetEnabledPayload): AgentConfigSetEnabledCommand {
  return { v: PROTOCOL_VERSION, type: "agent.config.set_enabled", payload };
}

/** agent.base_prompt.get：base 段系统提示词懒查询读面（base prompt 批；
 *  全局命令；回执 = agent.base_prompt.get.result 点对点）。 */
export function agentBasePromptGetCommand(payload: AgentBasePromptGetPayload): AgentBasePromptGetCommand {
  return { v: PROTOCOL_VERSION, type: "agent.base_prompt.get", payload };
}

/** web.status：CDP 连接状态读面（全局命令；回执 = web.status.result 点对点）。 */
export function webStatusCommand(): WebStatusCommand {
  return { v: PROTOCOL_VERSION, type: "web.status", payload: {} };
}

/** web.stop：手动停止写面（全局命令；回执 = web.stop.result 点对点 +
 *  状态回 idle 经 web.status.changed 全局广播）。 */
export function webStopCommand(): WebStopCommand {
  return { v: PROTOCOL_VERSION, type: "web.stop", payload: {} };
}

/** web.start：显式启动写面（v0.9，T7；全局命令；回执 = web.start.result
 *  点对点 applied/skipped + 状态回流经 web.status.changed 全局广播）。 */
export function webStartCommand(): WebStartCommand {
  return { v: PROTOCOL_VERSION, type: "web.start", payload: {} };
}

// ── kg 族命令（契约 v0.11 kg 批，contracts/kg-viewer-api.md；T5.4）────
// 六命令全部全局命令（信封 sessionId 省略）；五个图谱命令 payload 必填
// project（名称或绝对路径，daemon 单点解析）；kg.projects 无参。回执 =
// kg.*.result 点对点帧（O-6 轮询裁决零推送事件）。

/** kg.projects：workspace 项目列表（F5.0 左栏数据源；宽松口径含 absent）。 */
export function kgProjectsCommand(): KgProjectsCommand {
  return { v: PROTOCOL_VERSION, type: "kg.projects", payload: {} };
}

/** kg.list：节点列表+搜索（F5.1；q×kind×status 三路过滤可叠加，均可省略）。 */
export function kgListCommand(payload: KgListPayload): KgListCommand {
  return { v: PROTOCOL_VERSION, type: "kg.list", payload };
}

/** kg.node.detail：节点详情六段聚合（F5.2）。 */
export function kgNodeDetailCommand(payload: KgNodeDetailPayload): KgNodeDetailCommand {
  return { v: PROTOCOL_VERSION, type: "kg.node.detail", payload };
}

/** kg.change.report：知识变化报告（F5.3；iterationId 缺省 = 当前迭代）。 */
export function kgChangeReportCommand(payload: KgChangeReportPayload): KgChangeReportCommand {
  return { v: PROTOCOL_VERSION, type: "kg.change.report", payload };
}

/** kg.node.confirm：draft 审阅转正（F5.4 页面唯一写动作；仅 draft 可转正）。 */
export function kgNodeConfirmCommand(payload: KgNodeConfirmPayload): KgNodeConfirmCommand {
  return { v: PROTOCOL_VERSION, type: "kg.node.confirm", payload };
}

/** kg.index.status：索引状态四态面板（F5.5；rebuild:true = 触发构建/重建，
 *  absent 态触发即首次构建 B1；O-6 前端轮询本命令获取进度）。 */
export function kgIndexStatusCommand(payload: KgIndexStatusPayload): KgIndexStatusCommand {
  return { v: PROTOCOL_VERSION, type: "kg.index.status", payload };
}

// ── kg-bootstrap 批五命令（iter-20260829-ys7q T3.2；契约 contracts/kg-bootstrap-api.md）────
// 全局命令（信封 sessionId 省略）；回执 = kg.*.result 点对点帧（零推送同规）。
// V-1：产出即 confirmed 无草稿；修正 = update/supersede（理由必填）；连带 =
// impact 只读推导（不落库零自动写）。

/** kg.bootstrap.create：发起 bootstrap 任务（CL-1；后端准入机械复核 + createTask 同源）。 */
export function kgBootstrapCreateCommand(payload: KgBootstrapCreatePayload): KgBootstrapCreateCommand {
  return { v: PROTOCOL_VERSION, type: "kg.bootstrap.create", payload };
}

/** kg.bootstrap.produce：产出三级分组读面（CL-4 F4.1；absent → 空 groups）。 */
export function kgBootstrapProduceCommand(payload: KgBootstrapProducePayload): KgBootstrapProduceCommand {
  return { v: PROTOCOL_VERSION, type: "kg.bootstrap.produce", payload };
}

/** kg.node.update：修正写面一（内联编辑保存即 updateNode，保持 confirmed）。 */
export function kgNodeUpdateCommand(payload: KgNodeUpdatePayload): KgNodeUpdateCommand {
  return { v: PROTOCOL_VERSION, type: "kg.node.update", payload };
}

/** kg.node.supersede：修正写面二（理由必填双防线 + 留史）。 */
export function kgNodeSupersedeCommand(payload: KgNodeSupersedePayload): KgNodeSupersedeCommand {
  return { v: PROTOCOL_VERSION, type: "kg.node.supersede", payload };
}

/** kg.bootstrap.impact：受影响连带只读推导（CL-4 F4.3；update/supersede 成功后刷新标记）。 */
export function kgBootstrapImpactCommand(payload: KgBootstrapImpactPayload): KgBootstrapImpactCommand {
  return { v: PROTOCOL_VERSION, type: "kg.bootstrap.impact", payload };
}

// ── kg 维护批两命令（C1；契约 PROTOCOL.md §22）────
// 全局命令（信封 sessionId 省略）；回执 = kg.*.result 点对点帧（零推送同规）。
// 职责分层：purge 清 kg 库全部内容（不动 .codegraph）；index.delete 删索引
// 目录（不动知识层）。

/** kg.graph.purge：清空图谱（危险操作——UI 两步确认；daemon 门禁：运行中 kg-bootstrap 任务拒绝）。 */
export function kgGraphPurgeCommand(payload: KgGraphPurgePayload): KgGraphPurgeCommand {
  return { v: PROTOCOL_VERSION, type: "kg.graph.purge", payload };
}

/** kg.index.delete：删除索引（停 watcher + 删 .codegraph + 状态复位 absent；可重建）。 */
export function kgIndexDeleteCommand(payload: KgIndexDeletePayload): KgIndexDeleteCommand {
  return { v: PROTOCOL_VERSION, type: "kg.index.delete", payload };
}

// ── kg.health 批 + kg 评审批命令（W2-E 体检看板 / W2-F 轨二；契约 PROTOCOL.md §15.9/§23）────
// 全局命令（信封 sessionId 省略）；回执 = kg.*.result 点对点帧（零推送同规）。

/** kg.health：结构体检五项读面聚合（只列不修零写路径；absent 短路空态不建库）。 */
export function kgHealthCommand(payload: KgHealthPayload): KgHealthCommand {
  return { v: PROTOCOL_VERSION, type: "kg.health", payload };
}

/** kg.candidates.list：候选台账列表（status 四态过滤 + 分页；行含 body 全文；只读零裁决）。 */
export function kgCandidatesListCommand(payload: KgCandidatesListPayload): KgCandidatesListCommand {
  return { v: PROTOCOL_VERSION, type: "kg.candidates.list", payload };
}

/** kg.review.create：发起语义体检任务（准入从简 = 索引存在即可，允许反复发起）。 */
export function kgReviewCreateCommand(payload: KgReviewCreatePayload): KgReviewCreateCommand {
  return { v: PROTOCOL_VERSION, type: "kg.review.create", payload };
}

/** code.review.create：发起代码评审任务（code-review v1.5；准入从简——无索引门槛，允许反复发起）。 */
export function codeReviewCreateCommand(payload: CodeReviewCreatePayload): CodeReviewCreateCommand {
  return { v: PROTOCOL_VERSION, type: "code.review.create", payload };
}

// ── workspace 族命令（W3 门禁；契约 PROTOCOL.md §15.10）──────────────
// 两命令均为全局命令（信封 sessionId 省略）；回执 = §16.10 点对点结果帧
//（workspace.get.result / workspace.open.result，SessionContext 转发层
// → entities/workspace 状态机消费）；校验/持久化全在 daemon 单点，前端
// 零重复实现（W3 门禁读/写面）。

/** workspace.get：门禁读面（无参；current 非 null → 主壳 / null → 选择页）。 */
export function workspaceGetCommand(): WorkspaceGetCommand {
  return { v: PROTOCOL_VERSION, type: "workspace.get", payload: {} };
}

/** workspace.open：显式绑定写面（daemon realpath 规范化 + 危险根校验）。 */
export function workspaceOpenCommand(root: string): WorkspaceOpenCommand {
  return { v: PROTOCOL_VERSION, type: "workspace.open", payload: { root } };
}

// ── task 族命令（T3.1；契约 contracts/task-api.md §2；iter-20260829-ys7q）──
// 九命令全部全局命令（信封 sessionId 省略——任务为 daemon 级实体）；
// 回执 = task.*.result 点对点帧（SessionContext 转发层 → P-2 页面私有
// reducer；错误走 connection.error，生命周期词表 = 契约 §4）。零内容干预
//（AD-2）：无 steer/重试命令——九命令即全集。

/** task.list：全局平铺列表（服务端排序 = 运行中置顶+创建时间倒序；
 *  过滤器入参服务端生效，页面另持客户端镜像派生）。 */
export function taskListCommand(payload: TaskListPayload = {}): TaskListCommand {
  return { v: PROTOCOL_VERSION, type: "task.list", payload };
}

/** task.detail：阶段条 + 当前阶段批次 + 实例 plan + 叙述句（R-4~R-8）。 */
export function taskDetailCommand(payload: TaskDetailPayload): TaskDetailCommand {
  return { v: PROTOCOL_VERSION, type: "task.detail", payload };
}

/** task.artifacts：阶段产物只读投影（F3.4；节点修正转 /project 页 AD-10）。 */
export function taskArtifactsCommand(payload: TaskArtifactsPayload): TaskArtifactsCommand {
  return { v: PROTOCOL_VERSION, type: "task.artifacts", payload };
}

/** task.subscribe：连接级订阅（缺省 jobId = 订阅全部变更；重连重发）。 */
export function taskSubscribeCommand(payload: TaskSubscribePayload = {}): TaskSubscribeCommand {
  return { v: PROTOCOL_VERSION, type: "task.subscribe", payload };
}

/** task.unsubscribe：清空订阅集（对称语义）。 */
export function taskUnsubscribeCommand(payload: TaskUnsubscribePayload = {}): TaskUnsubscribeCommand {
  return { v: PROTOCOL_VERSION, type: "task.unsubscribe", payload };
}

/** task.pause：仅 running→paused（O-2 停派新批次+在跑自然收口）。 */
export function taskPauseCommand(jobId: string): TaskPauseCommand {
  return { v: PROTOCOL_VERSION, type: "task.pause", payload: { jobId } };
}

/** task.resume：仅 paused→running（断点恢复同路径）。 */
export function taskResumeCommand(jobId: string): TaskResumeCommand {
  return { v: PROTOCOL_VERSION, type: "task.resume", payload: { jobId } };
}

/** task.cancel：pending/running/paused→cancelled 终态（在跑批次 SIGTERM）。 */
export function taskCancelCommand(jobId: string): TaskCancelCommand {
  return { v: PROTOCOL_VERSION, type: "task.cancel", payload: { jobId } };
}

/** task.delete：仅终态可删；清任务域全部记录不触 kg 产出（F3.6）。 */
export function taskDeleteCommand(jobId: string): TaskDeleteCommand {
  return { v: PROTOCOL_VERSION, type: "task.delete", payload: { jobId } };
}
