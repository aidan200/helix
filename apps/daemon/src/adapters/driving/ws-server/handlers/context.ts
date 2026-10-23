/**
 * handlers/ 共享上下文（解环：ConnState / WsCommandContext 自
 * WsServerAdapter / handlers/model 机械上收——纯 type 搬移，零运行时行为）。
 *
 * 解环前三模块静态环：WsServerAdapter → handlers/auth（值导入）→
 * handlers/model（WsCommandContext type 导入）→ WsServerAdapter（ConnState
 * type 导入，回边）。两个类型定义上收本模块后，handlers/* 只依赖本模块
 * （type-only），不再有指回 WsServerAdapter 的边，环解。
 *
 * handler 化：session/chat/agent/trace 族上下文类型同承本模块——12 个
 * 内联 case 体自 WsServerAdapter.routeCommand 机械迁出（AD-1），依赖面经
 * 对应族上下文由 adapter 解构供出（commandContext 先例模式）；快照
 * 盖章链（snapshotFrame/sessionStamp）留 adapter，session/chat handler 经
 * 上下文回调机械引用零行为差（不为省行数造成第二份）。
 *
 * 本模块依赖纪律：只 import @helix/protocol 类型 + ../EventStream 类型 +
 * application/ports 类型 + bun ServerWebSocket 类型（另 trace 族依赖
 * domain/trace/TraceQueryPort、kg 族依赖 application service KgViewerService
 * ——architecture.md §9 明文「driving/kg.ts 调 application service」的
 * 既有口径，均为 type-only，自身不成为任何环的节点；workspace 族
 * WorkspaceService / task 族 TaskQueryService 同口径 type-only）
 */
import type { ServerWebSocket } from "bun";
import type {
  AgentStateDto,
  ConnectionErrorEvent,
  EventEnvelope,
  SessionSnapshotEvent,
} from "@helix/protocol";
import type { ModelPort } from "../../../../application/ports/inbound/ModelPort";
import type { CompactionConfigPort } from "../../../../application/ports/outbound/CompactionConfigPort";
import type { SchedulingConfigPort } from "../../../../application/ports/outbound/SchedulingConfigPort";
import type { PortConfigPort } from "../../../../application/ports/outbound/PortConfigPort";
import type { SandboxConfigPort } from "../../../../application/ports/outbound/SandboxConfigPort";
import type { ProxyConfigPort } from "../../../../application/ports/outbound/ProxyConfigPort";
import type { SummaryConfigPort } from "../../../../application/ports/outbound/SummaryConfigPort";
import type { KgConfigPort } from "../../../../application/ports/outbound/KgConfigPort";
import type { VoiceModelConfigPort } from "../../../../application/ports/outbound/VoiceModelConfigPort";
import type { AskService } from "../../../../application/services/AskService";
import type { AuthLoginService } from "../../../../application/services/AuthLoginService";
import type { SystemPort } from "../../../../application/ports/inbound/SystemPort";
import type { SessionDirectoryPort } from "../../../../application/ports/inbound/SessionDirectoryPort";
import type { SessionChatPort } from "../../../../application/ports/inbound/ChatPort";
import type { AgentOrchestrationPort } from "../../../../application/ports/inbound/AgentOrchestrationPort";
import type { SessionStateView } from "../../../../application/ports/inbound/SessionPort";
import type { ResourceConfigPort } from "../../../../application/ports/inbound/ResourceConfigPort";
import type { BrowserPort } from "../../../../application/ports/outbound/BrowserPort";
import type { SttPort } from "../../../../application/ports/outbound/SttPort";
import type { SttStreamService } from "../../../../application/stt/SttStreamService";
import type { TtsPort } from "../../../../application/ports/outbound/TtsPort";
import type { TtsStreamService } from "../../../../application/tts/TtsStreamService";
import type { StewardService } from "../../../../application/steward/StewardService";
import type { StewardActivityService } from "../../../../application/steward/StewardActivityService";
import type { SurfaceRegistry } from "../../../../application/surface/SurfaceRegistry";
import type { EmbeddingConfigService } from "../../../../application/embedding/EmbeddingConfigService";
import type { CustomProviderService } from "../../../../application/services/CustomProviderService";
import type { EventStream, FrameSender } from "../EventStream";
import type { TraceQueryPort } from "../../../../domain/trace/TraceQueryPort";
import type { KgViewerService } from "../../../../application/services/kg/KgViewerService";
import type { KgBootstrapService } from "../../../../application/services/kg/KgBootstrapService";
import type { KgMaintenanceService } from "../../../../application/services/kg/KgMaintenanceService";
import type { KgReviewService } from "../../../../application/services/kg/KgReviewService";
import type { KgTriageService } from "../../../../application/services/kg/KgTriageService";
import type { CodeReviewService } from "../../../../application/services/kg/CodeReviewService";
import type { WorkspaceService } from "../../../../application/services/workspace/WorkspaceService";
import type { TaskQueryService } from "../../../../application/services/task/TaskQueryService";
import type { TaskEnginePort } from "../../../../application/ports/inbound/TaskEnginePort";
import type { TurnDiffService, TurnDiffState } from "../../../../application/services/TurnDiffService";
import type {
  McpServerConfigInput,
  McpServerPort,
} from "../../../../application/ports/outbound/McpServerPort";

/** 每连接状态（Bun.serve 泛型，经 server.upgrade 的 data 携带；handlers/ 共用型）。 */
export interface ConnState {
  authed: boolean;
  /** welcome 帧已发标志（评审 B9）：握手链路中段抛错时 authed 已置位但
   *  welcome 从未发出——排队帧回放守卫改看本位（authed 不再作回放门），
   *  保证 *.result 回执永不早于 welcome（E-54③）。 */
  welcomed?: boolean;
  /** 认证通过后构造的协议帧发送端（EventStream 注册键）。 */
  sender: FrameSender | null;
  /**
   * daemon 主动 close 标记（快照体量批日志增强）：daemon 侧 close 点
   *（背压/握手拒绝/握手超时/坏帧）在 close 前置位；onClose 据此区分
   * 「daemon: <原因>」与「client」——修复前「ws close remote=...」不区分
   * 发起方，重连循环排障无从判向。
   */
  daemonClose?: string;
}

/** per-session 快照盖章（语义 = WsServerAdapter.sessionStamp：view 同源组装，禁 getStatus 串台）。 */
export type SessionStamp = (view: SessionStateView) => { model: string; agentState: AgentStateDto };

/** session.snapshot 组帧（语义 = WsServerAdapter.snapshotFrame：AD-1 尾窗口径；实现留 adapter）。 */
export type SnapshotFrame = (
  view: SessionStateView,
  model: string,
  agentState: AgentStateDto,
) => SessionSnapshotEvent;

/**
 * model/auth 族命令处理上下文（WsServerAdapter.routeCommand 解构后供出）。
 * 辅助方法与本连接绑定，语义 = WsServerAdapter 同名私有方法（机械转发零行为差）。
 */
export interface WsCommandContext {
  /** 命令来源连接（回执端解析：ws.data.sender ?? rawSender()）。 */
  readonly ws: ServerWebSocket<ConnState>;
  /** 命令类型字面（commandError 回执文案用）。 */
  readonly type: string;
  /** 命令 payload（routeCommand 已解构为 Record）。 */
  readonly payload: Record<string, unknown>;
  /** 命令信封（会话作用域命令的 sessionId 路由位，v0.2）。 */
  readonly envelope: { sessionId?: unknown };
  /** 模型/认证管理入口（AD-2 回口，只转发不决策）。 */
  readonly model: ModelPort;
  /** 压缩参数配置读写面（config 族命令回口；未装配 → undefined，handler 回 unimplemented）。 */
  readonly compactionConfig?: CompactionConfigPort;
  /** SubAgent 调度预算读写面（config 族命令回口；未装配 → undefined）。 */
  readonly schedulingConfig?: SchedulingConfigPort;
  /** WS 端口配置读写面（config 族命令回口；未装配 → undefined）。 */
  readonly portConfig?: PortConfigPort;
  /** 沙箱开关（config.get/set_sandbox 命令族；沙箱开关批）。 */
  readonly sandboxConfig?: SandboxConfigPort;
  /** 网络代理（config.get/set_proxy 命令族；网络代理批——运行期即热）。 */
  readonly proxyConfig?: ProxyConfigPort;
  /** 总结配置读写面（config.get/set_summary 命令族——summary.* 通用域；
   * 未装配 → unimplemented）。 */
  readonly summaryConfig?: SummaryConfigPort;
  /** 知识库配置读写面（config.get/set_kg 命令族——查重阈值，批2 WP-C
   *  「知识库」配置组；未装配 → unimplemented）。 */
  readonly kgConfig?: KgConfigPort;
  /** ASR/TTS 模型配置读写面（config.get/set_voice_models 命令族——
   *  模型配置接入 P0；未装配 → unimplemented）。 */
  readonly voiceModelConfig?: VoiceModelConfigPort;
  /** 提权申请仲裁面（ask.answer 命令回口；未装配 → unimplemented）。 */
  readonly askService?: AskService;
  /** 登录流程编排面（auth.login/respond/cancel/logout 命令回口，订阅登录批；
   *  未装配 → unimplemented）。 */
  readonly authLogin?: AuthLoginService;
  /** 缺省会话回退源（system.getStatus().sessionId，v0 兼容读）。 */
  readonly system: SystemPort;
  /** 命令错误回执（connection.error 帧；语义 = WsServerAdapter.commandError）。 */
  commandError(type: string, code: ConnectionErrorEvent["payload"]["code"], message: string): void;
  /** 模型/认证命令错误码映射（契约 C §4；语义 = WsServerAdapter.modelErrorCode）。 */
  modelErrorCode(err: Error): ConnectionErrorEvent["payload"]["code"];
  /** 构造本连接协议帧发送端（readyState 守卫；语义 = WsServerAdapter.rawSender）。 */
  rawSender(): FrameSender;
  /** 立即发帧（语义 = WsServerAdapter.sendNow）。 */
  sendNow(sender: FrameSender, frame: EventEnvelope): void;
}

/**
 * session 族命令处理上下文（list / loadHistory / delete / subscribe /
 * unsubscribe，契约 B §1）：SessionDirectoryPort（目录/视图/删除）+
 * EventStream 订阅面（重新订阅重推快照链）+ 快照盖章链回调 + 共享辅助。
 * 目标会话解析（resolveTargetSession）随族迁 handlers/session.ts 模块内。
 */
export interface SessionCommandContext {
  /** 命令来源连接（sender = ws.data.sender；list/loadHistory 回退 rawSender()）。 */
  readonly ws: ServerWebSocket<ConnState>;
  /** 命令类型字面（commandError 回执文案用）。 */
  readonly type: string;
  /** 命令 payload（routeCommand 已解构为 Record）。 */
  readonly payload: Record<string, unknown>;
  /** 命令信封（会话作用域命令的 sessionId 路由位，v0.2）。 */
  readonly envelope: { sessionId?: unknown };
  /** 会话目录（list/loadHistory/delete/目标解析/视图取数）。 */
  readonly directory: SessionDirectoryPort;
  /** 事件流（订阅/退订 + 重推快照经 sender）。 */
  readonly events: EventStream;
  /** per-session 快照盖章回调（语义 = WsServerAdapter.sessionStamp）。 */
  readonly sessionStamp: SessionStamp;
  /** session.snapshot 组帧回调（语义 = WsServerAdapter.snapshotFrame）。 */
  readonly snapshotFrame: SnapshotFrame;
  /** 命令错误回执（语义 = WsServerAdapter.commandError）。 */
  commandError(type: string, code: ConnectionErrorEvent["payload"]["code"], message: string): void;
  /** 构造本连接协议帧发送端（语义 = WsServerAdapter.rawSender）。 */
  rawSender(): FrameSender;
  /** 立即发帧（语义 = WsServerAdapter.sendNow）。 */
  sendNow(sender: FrameSender, frame: EventEnvelope): void;
}

/**
 * chat 族命令处理上下文（send 含草稿建会话链 / steer / abort）：ChatPort
 * 发送面 + SessionDirectoryPort（草稿建会话/视图取数）+ EventStream（建会话
 * 订阅）+ 快照盖章链回调（草稿快照盖新会话自身章）+ 共享辅助。
 */
export interface ChatCommandContext {
  /** 命令来源连接（草稿链快照回执端 = ws.data.sender）。 */
  readonly ws: ServerWebSocket<ConnState>;
  /** 命令类型字面（commandError 回执文案用）。 */
  readonly type: string;
  /** 命令 payload（routeCommand 已解构为 Record）。 */
  readonly payload: Record<string, unknown>;
  /** 命令信封（会话作用域命令的 sessionId 路由位，v0.2）。 */
  readonly envelope: { sessionId?: unknown };
  /** 会话路由对话入口（组合根 ChatRouter——按信封 sessionId 分发）。 */
  readonly chat: SessionChatPort;
  /** 会话目录（草稿建会话链 startDraftSession + getSessionView）。 */
  readonly directory: SessionDirectoryPort;
  /** 事件流（草稿建会话后本连接订阅该会话）。 */
  readonly events: EventStream;
  /** per-session 快照盖章回调（语义 = WsServerAdapter.sessionStamp）。 */
  readonly sessionStamp: SessionStamp;
  /** session.snapshot 组帧回调（语义 = WsServerAdapter.snapshotFrame）。 */
  readonly snapshotFrame: SnapshotFrame;
  /**
   * workspace 绑定态判别面（W1 会话创建门禁：未绑定 → 拒绝并指引
   * 「请先选择工作空间」）；缺省 = 未装配 workspace 面（stub 测试形态）
   * 视为已绑定。
   */
  workspaceBound?: () => boolean;
  /** 命令错误回执（语义 = WsServerAdapter.commandError）。 */
  commandError(type: string, code: ConnectionErrorEvent["payload"]["code"], message: string): void;
  /** 立即发帧（语义 = WsServerAdapter.sendNow）。 */
  sendNow(sender: FrameSender, frame: EventEnvelope): void;
}

/**
 * agent 族命令处理上下文（kill / subscribe / unsubscribe，契约 §4）：
 * AgentOrchestrationPort（kill 终止链回 SchedulerService）+ EventStream
 * （实例订阅通路，§8-1 通路语义不过滤）+ commandError。
 */
export interface AgentCommandContext {
  /** 命令来源连接（subscribe/unsubscribe 的 sender = ws.data.sender）。 */
  readonly ws: ServerWebSocket<ConnState>;
  /** 命令类型字面（commandError 回执文案用）。 */
  readonly type: string;
  /** 命令 payload（routeCommand 已解构为 Record）。 */
  readonly payload: Record<string, unknown>;
  /** 编排入口（agent.kill 终止链，只转发不决策）。 */
  readonly orchestration: AgentOrchestrationPort;
  /** 事件流（实例订阅/退订通路）。 */
  readonly events: EventStream;
  /** 命令错误回执（语义 = WsServerAdapter.commandError）。 */
  commandError(type: string, code: ConnectionErrorEvent["payload"]["code"], message: string): void;
}

/**
 * trace 族命令处理上下文（trace.query，契约 v0.4 §1）：trace 读面
 * （未装配 → undefined，handler 回 command.unimplemented——连接私有读面）。
 */
export interface TraceCommandContext {
  /** 命令来源连接（回执端解析：ws.data.sender ?? rawSender()）。 */
  readonly ws: ServerWebSocket<ConnState>;
  /** 命令类型字面（commandError 回执文案用）。 */
  readonly type: string;
  /** 命令 payload（routeCommand 已解构为 Record；目标会话在 payload.sessionId）。 */
  readonly payload: Record<string, unknown>;
  /** trace 读面（deps.traceQuery 可选装配面直传）。 */
  readonly traceQuery: TraceQueryPort | undefined;
  /** 命令错误回执（语义 = WsServerAdapter.commandError）。 */
  commandError(type: string, code: ConnectionErrorEvent["payload"]["code"], message: string): void;
  /** 构造本连接协议帧发送端（语义 = WsServerAdapter.rawSender）。 */
  rawSender(): FrameSender;
  /** 立即发帧（语义 = WsServerAdapter.sendNow）。 */
  sendNow(sender: FrameSender, frame: EventEnvelope): void;
}

/**
 * agent.config 族命令处理上下文（v0.6）：ResourceConfigPort
 * （配置读写面）+ 合并目录校验窄函数（model 型前置校验 hasModel，
 * ModelService.setModel 先例）+ EventStream（applied 时 agent.config.changed
 * 广播）+ 共享辅助。全局命令（信封 sessionId 不消费）。
 */
export interface ResourceCommandContext {
  /** 命令来源连接（回执端解析：ws.data.sender ?? rawSender()）。 */
  readonly ws: ServerWebSocket<ConnState>;
  /** 命令类型字面（commandError 回执文案用）。 */
  readonly type: string;
  /** 命令 payload（routeCommand 已解构为 Record）。 */
  readonly payload: Record<string, unknown>;
  /** 资源配置读写面（list/setEnabled/setModelSlot/clearModelSlot）。 */
  readonly resource: ResourceConfigPort;
  /** 合并目录校验面（model 型 set 前置校验；目录外 → skipped/unknown-model）。 */
  readonly hasModel: (modelId: string) => boolean;
  /**
   * kg-writer 派生面恒在工具名（agent-roster 批）：组合根注入
   * SUBAGENT_KG_WRITER_EXTRA_TOOLS 增量常量单源——driving 不得 import
   * driven，经窄数据面传递（hasModel 同法）。list 缺省全量时读面派生
   * system 只读块用。
   */
  readonly kgWriterPinnedTools: readonly string[];
  /**
   * base 段系统提示词读面（base prompt 批）：kind → profile 静态声明
   * prompt 全文（五 kind 含系统派生；kg-writer = SUBAGENT base + 图谱产出
   * 型后缀 / reviewer = SUBAGENT base + 评审纪律后缀，profile 声明单源）。组合根从四 profile 的 systemPrompt 字段
   * 取值注入——driving 不得 import driven，经窄数据面传递
   * （kgWriterPinnedTools/hasModel 同法）。agent.base_prompt.get 读面用。
   */
  readonly basePrompts: Readonly<Record<string, string>>;
  /**
   * skill 正文读面（skill-content 批）：技能名 → SKILL.md 全文 + 路径；
   * 未知名/读取失败 → undefined（handler 回 command.invalid_payload）。
   * 组合根窄函数注入（scan 现拍 + 读文件——driving 不 import driven，
   * basePrompts 同法）；agent.skill_content.get 懒查询用。
   */
  readonly skillContentOf: (name: string) => Promise<{ filePath: string; content: string } | undefined>;
  /**
   * 用户级技能创建写面（skills 添加批）：SKILL.md 全文 → SkillCreateOutcome
   *（applied { name } / skipped { reason }；SkillScanner 权威校验与落盘）。
   * 组合根窄函数注入（driving 不 import driven，skillContentOf 同法）；
   * agent.skill.create 写面用。可选：未注入（stub rig）→ skipped 防御。
   */
  readonly skillCreateOf?: (content: string) => Promise<import("../../../../application/ports/outbound/SkillSourcePort").SkillCreateOutcome>;
  /** 事件流（applied → agent.config.changed 广播）。 */
  readonly events: EventStream;
  /** 命令错误回执（语义 = WsServerAdapter.commandError）。 */
  commandError(type: string, code: ConnectionErrorEvent["payload"]["code"], message: string): void;
  /** 构造本连接协议帧发送端（语义 = WsServerAdapter.rawSender）。 */
  rawSender(): FrameSender;
  /** 立即发帧（语义 = WsServerAdapter.sendNow）。 */
  sendNow(sender: FrameSender, frame: EventEnvelope): void;
}

/**
 * web 族命令处理上下文（v0.7）：BrowserPort（连接状态
 * 读面 getStatus + listTabs / 停止写面 stop）+ 共享辅助。全局命令
 *（信封 sessionId 不消费）。状态变更广播不走本上下文——由组合根
 * onStatusChange 接线直发（web.stop 后的 idle 回流同路径，handler 不重复广播）。
 */
export interface WebCommandContext {
  /** 命令来源连接（回执端解析：ws.data.sender ?? rawSender()）。 */
  readonly ws: ServerWebSocket<ConnState>;
  /** 命令类型字面（commandError 回执文案用）。 */
  readonly type: string;
  /** 浏览器连接面（getStatus/listTabs/stop；只转发不决策）。 */
  readonly browser: BrowserPort;
  /** 命令错误回执（语义 = WsServerAdapter.commandError）。 */
  commandError(type: string, code: ConnectionErrorEvent["payload"]["code"], message: string): void;
  /** 构造本连接协议帧发送端（语义 = WsServerAdapter.rawSender）。 */
  rawSender(): FrameSender;
  /** 立即发帧（语义 = WsServerAdapter.sendNow）。 */
  sendNow(sender: FrameSender, frame: EventEnvelope): void;
}

/** stt 族命令回口（语音输入批 V1 + V3b-1 流式批）：SttPort 装配清单 +
 *  key 读面 + 流式会话面（只转发不决策）。 */
export interface SttCommandDeps {
  /** 已装配 STT provider 端口（装配优先序：dashscope 在前、siliconflow 兜底）。 */
  readonly providers: readonly SttPort[];
  /** key 读面（组合根注入 authStore.apiKeyOf——provider 自动选择判据；每次调用重读）。 */
  readonly apiKeyOf: (providerId: string) => string | undefined;
  /**
   * 流式转写面（V3b-1）：连接级单流生命周期服务（stt.stream 四命令回口 +
   * 断连清理）。可选：未注入 → stt.stream.* 回 command.unimplemented
   *（stt 先例；stub rig 兼容）。
   */
  readonly stream?: { readonly service: SttStreamService };
}

/**
 * stt 族命令处理上下文（语音输入批 V1）：SttCommandDeps + 会话目录
 *（P1 会话源读面 + sessionId 归属自查）+ 共享辅助（webContext 同构）。
 */
export interface SttCommandContext {
  /** 命令来源连接（回执端解析：ws.data.sender ?? rawSender()）。 */
  readonly ws: ServerWebSocket<ConnState>;
  /** 命令类型字面（commandError 回执文案用）。 */
  readonly type: string;
  /** 命令 payload（routeCommand 已解构为 Record）。 */
  readonly payload: Record<string, unknown>;
  /** 命令信封（会话作用域可选命令的 sessionId 路由位；省略 = 无会话裸转写）。 */
  readonly envelope: { sessionId?: unknown };
  /** 会话目录（resolveTarget 归属自查 + getSessionView P1 会话源）。 */
  readonly directory: SessionDirectoryPort;
  /** STT provider 装配清单 + key 读面（只转发不决策）。 */
  readonly stt: SttCommandDeps;
  /** 命令错误回执（语义 = WsServerAdapter.commandError）。 */
  commandError(type: string, code: ConnectionErrorEvent["payload"]["code"], message: string): void;
  /** 构造本连接协议帧发送端（语义 = WsServerAdapter.rawSender）。 */
  rawSender(): FrameSender;
  /** 立即发帧（语义 = WsServerAdapter.sendNow）。 */
  sendNow(sender: FrameSender, frame: EventEnvelope): void;
}

/**
 * kg 族命令处理上下文（P-1 六命令族，§9）：KgViewerService（application
 * service 面——architecture.md §9 明文「driving/kg.ts 调 application
 * service」；project 参数在 service 内单点解析，handlers 禁自带 join）
 * + 共享辅助。全局命令（信封 sessionId 不消费）；kg 栈未装配 →
 * undefined，handler 回 command.unimplemented（trace.ts 先例）。
 * W1 绑定闭环：workspaceUnbound = 装配了 workspace 面但未绑定——
 * kg 读面防御契约（空集结果，非报错；门禁前端本不发这些请求）。
 */
export interface KgCommandContext {
  /** 命令来源连接（回执端解析：ws.data.sender ?? rawSender()）。 */
  readonly ws: ServerWebSocket<ConnState>;
  /** 命令类型字面（commandError 回执文案用）。 */
  readonly type: string;
  /** 命令 payload（routeCommand 已解构为 Record）。 */
  readonly payload: Record<string, unknown>;
  /** P-1 六命令应用编排面（deps.kg/workspace 持有者读面；未装配 → undefined）。 */
  readonly kg: KgViewerService | undefined;
  /** kg-bootstrap 五命令应用编排面（T3.2，契约 kg-bootstrap-api；未装配 →
   *  undefined，handler 回 command.unimplemented；生产面经容器 workspace
   *  现值解析器组装，直接注入形态保留给 stub 测试 rig）。 */
  readonly bootstrap: KgBootstrapService | undefined;
  /** kg 维护批两命令应用编排面（C1：kg.graph.purge / kg.index.delete，契约
   *  PROTOCOL-CHANGELOG.md §22；未装配 → undefined，handler 回 command.unimplemented；
   *  生产面经容器 workspace 现值解析器组装，kgBootstrap 同接缝）。 */
  readonly maintenance: KgMaintenanceService | undefined;
  /** kg 评审批一命令应用编排面（W2-F：kg.review.create，契约 PROTOCOL-CHANGELOG.md §23；
   *  未装配 → undefined，handler 回 command.unimplemented；生产面经容器
   *  workspace 现值解析器组装，kgBootstrap/kgMaintenance 同接缝）。 */
  readonly review: KgReviewService | undefined;
  /** kg 待办面裁决批一命令应用编排面（kg-triage P1：kg.triage.create——发起面 + 待办面三计数读面；
   * 未装配 → command.unimplemented）。 */
  readonly triage: KgTriageService | undefined;
  /** code-review 批一命令应用编排面（code-review v1.5：code.review.create；
   *  未装配 → undefined，handler 回 command.unimplemented；生产面经容器
   *  workspace 现值解析器组装，kgReview 同接缝）。 */
  readonly codeReview: CodeReviewService | undefined;
  /** workspace 面已装配且未绑定（unbound 防御契约判别；未装配面 = false）。 */
  readonly workspaceUnbound: boolean;
  /** 命令错误回执（语义 = WsServerAdapter.commandError）。 */
  commandError(type: string, code: ConnectionErrorEvent["payload"]["code"], message: string): void;
  /** 构造本连接协议帧发送端（语义 = WsServerAdapter.rawSender）。 */
  rawSender(): FrameSender;
  /** 立即发帧（语义 = WsServerAdapter.sendNow）。 */
  sendNow(sender: FrameSender, frame: EventEnvelope): void;
}

/**
 * workspace 族命令处理上下文（W1 绑定闭环）：WorkspaceService（application
 * service 面——绑定状态机唯一事实源，handlers 只转发不决策）+ 共享辅助。
 * 全局命令（信封 sessionId 不消费）；workspace 面未装配（stub 测试形态）
 * → routeCommand 不分发本族（command.unknown）。
 */
export interface WorkspaceCommandContext {
  /** 命令来源连接（回执端解析：ws.data.sender ?? rawSender()）。 */
  readonly ws: ServerWebSocket<ConnState>;
  /** 命令类型字面（commandError 回执文案用）。 */
  readonly type: string;
  /** 命令 payload（routeCommand 已解构为 Record）。 */
  readonly payload: Record<string, unknown>;
  /** 绑定状态机（get 快照/open 写面；service 内单点校验与持久化）。 */
  readonly workspace: WorkspaceService;
  /** 命令错误回执（语义 = WsServerAdapter.commandError）。 */
  commandError(type: string, code: ConnectionErrorEvent["payload"]["code"], message: string): void;
  /** 构造本连接协议帧发送端（语义 = WsServerAdapter.rawSender）。 */
  rawSender(): FrameSender;
  /** 立即发帧（语义 = WsServerAdapter.sendNow）。 */
  sendNow(sender: FrameSender, frame: EventEnvelope): void;
}

/**
 * task 族命令处理上下文（P-2 任务页九命令族，§8.1）：TaskQueryService
 * 读面 + TaskEnginePort 生命周期写面（architecture §8.1——handlers 只转发
 * 不决策，状态判断收口引擎，task.invalid_state 透传）+ EventStream
 *（task.subscribe 连接级订阅表 + 生命周期成功即 task.changed 广播，O-7）
 * + 共享辅助。全局命令（信封 sessionId 不消费）；任务栈未装配 →
 * undefined，handler 回 command.unimplemented（kg.ts 先例）。
 */
export interface TaskCommandContext {
  /** 命令来源连接（回执端解析：ws.data.sender ?? rawSender()）。 */
  readonly ws: ServerWebSocket<ConnState>;
  /** 命令类型字面（commandError 回执文案用）。 */
  readonly type: string;
  /** 命令 payload（routeCommand 已解构为 Record）。 */
  readonly payload: Record<string, unknown>;
  /** P-2 读面投影（listTasks/getTaskDetail/getTaskArtifacts；未装配 → undefined）。 */
  readonly taskQuery: TaskQueryService | undefined;
  /** 生命周期写面（pause/resume/cancel/deleteTask；未装配 → undefined）。 */
  readonly taskEngine: TaskEnginePort | undefined;
  /** 事件流（task.changed 广播 + 连接级任务订阅表）。 */
  readonly events: EventStream;
  /** 命令错误回执（语义 = WsServerAdapter.commandError）。 */
  commandError(type: string, code: ConnectionErrorEvent["payload"]["code"], message: string): void;
  /** 构造本连接协议帧发送端（语义 = WsServerAdapter.rawSender）。 */
  rawSender(): FrameSender;
  /** 立即发帧（语义 = WsServerAdapter.sendNow）。 */
  sendNow(sender: FrameSender, frame: EventEnvelope): void;
}

/**
 * diff 族命令处理上下文（T3+T4 轮次 diff 协议与 UI 闭环，第十一族）：
 * diff.get 会话作用域查询面（信封 sessionId 必填——路由位在信封不在
 * payload）+ 点对点回执（diff.get.result，仅发发起连接）+ 共享辅助。
 * 查询面未装配（stub 测试形态）→ undefined，handler 回
 * command.unimplemented（task/kg 族先例）。TurnDiffService 为 application
 * service type-only 依赖（task 族 TaskQueryService 同口径）。
 */
export interface DiffCommandContext {
  /** 命令来源连接（回执端解析：ws.data.sender ?? rawSender()）。 */
  readonly ws: ServerWebSocket<ConnState>;
  /** 命令类型字面（commandError 回执文案用）。 */
  readonly type: string;
  /** 命令 payload（routeCommand 已解构为 Record；turnId?/live? 可选）。 */
  readonly payload: Record<string, unknown>;
  /** 命令信封（会话作用域命令的 sessionId 路由位，必填纪律在 handler 校验）。 */
  readonly envelope: { sessionId?: unknown };
  /** 轮次 diff 查询面：热会话 diff 状态读面（registry.peek().diff）+ 服务查询操作面。 */
  readonly diff:
    | {
        readonly stateOf: (sessionId: string) => TurnDiffState | undefined;
        readonly service: TurnDiffService;
      }
    | undefined;
  /** 命令错误回执（语义 = WsServerAdapter.commandError）。 */
  commandError(type: string, code: ConnectionErrorEvent["payload"]["code"], message: string): void;
  /** 构造本连接协议帧发送端（语义 = WsServerAdapter.rawSender）。 */
  rawSender(): FrameSender;
  /** 立即发帧（语义 = WsServerAdapter.sendNow）。 */
  sendNow(sender: FrameSender, frame: EventEnvelope): void;
}

/**
 * mcp 族命令处理上下文（mcp 批：MCP server 标准接入六命令）：
 * McpServerPort（连接生命周期 + 发现读面；McpServerPort.ts——MCP 协议
 * 细节全部收敛在 driven McpRegistry）+ 配置窄写面 saveMcpServers（组合根
 * 闭包包 writeConfig，与 registry 生命周期解耦——落盘与连接是两个关注点）
 * + 共享辅助。全局命令（信封 sessionId 不消费）。状态变更广播不走本
 * 上下文——组合根 onStatusChange 接线直发（CRUD 后的 running/stopped
 * 同路径自动触发刷新链，handler 不重复广播）。
 */
export interface McpCommandContext {
  /** 命令来源连接（回执端解析：ws.data.sender ?? rawSender()）。 */
  readonly ws: ServerWebSocket<ConnState>;
  /** 命令类型字面（commandError 回执文案用）。 */
  readonly type: string;
  /** 命令 payload（routeCommand 已解构为 Record）。 */
  readonly payload: Record<string, unknown>;
  /** MCP server 管理面（add/remove/test/listConfigs/getStatuses/toolsOf）。 */
  readonly mcp: McpServerPort;
  /** mcpServers 段整段替换落盘（mcp_server 表；async——落盘完成才返回，await 后才可连接；readonly 入参规范化在闭包内）。 */
  saveMcpServers(servers: readonly McpServerConfigInput[]): Promise<void>;
  /** 命令错误回执（语义 = WsServerAdapter.commandError）。 */
  commandError(type: string, code: ConnectionErrorEvent["payload"]["code"], message: string): void;
  /** 构造本连接协议帧发送端（语义 = WsServerAdapter.rawSender）。 */
  rawSender(): FrameSender;
  /** 立即发帧（语义 = WsServerAdapter.sendNow）。 */
  sendNow(sender: FrameSender, frame: EventEnvelope): void;
}

/** voice 族命令回口（语音播报批 V2 TTS：TtsPort + EventStream 连接级订阅面——只转发不决策）。 */
export interface VoiceCommandDeps {
  /** TTS 合成面（voice.synthesize 试听合成；provider 当前仅 dashscope；key 缺失由 adapter fail-fast）。 */
  readonly tts: TtsPort;
  /** EventStream 连接级 voice 订阅面（voice.subscribe/unsubscribe 登记）+
   *  健康上报（光球健康角标批：TTS 合成失败/恢复经此处上报）。 */
  readonly stream: Pick<EventStream, "subscribeVoice" | "unsubscribeVoice" | "reportStewardHealth">;
  /** 流式合成面（V3b-2 voice.synthesize.stream/stop；未装配 → unimplemented）。 */
  readonly ttsStream?: TtsStreamService;
}

/**
 * voice 族命令处理上下文（语音播报批 V2 TTS）：VoiceCommandDeps + 共享
 * 辅助（SttCommandContext 同构）。全局命令（信封 sessionId 不消费）——
 * 播报订阅是连接级状态，合成是 provider 调用，均无会话维。
 */
export interface VoiceCommandContext {
  /** 命令来源连接（回执端解析：ws.data.sender ?? rawSender()）。 */
  readonly ws: ServerWebSocket<ConnState>;
  /** 命令类型字面（commandError 回执文案用）。 */
  readonly type: string;
  /** 命令 payload（routeCommand 已解构为 Record）。 */
  readonly payload: Record<string, unknown>;
  /** TTS 合成面 + key 读面 + EventStream 订阅面（只转发不决策）。 */
  readonly voice: VoiceCommandDeps;
  /** 命令错误回执（语义 = WsServerAdapter.commandError）。 */
  commandError(type: string, code: ConnectionErrorEvent["payload"]["code"], message: string): void;
  /** 构造本连接协议帧发送端（语义 = WsServerAdapter.rawSender）。 */
  rawSender(): FrameSender;
  /** 立即发帧（语义 = WsServerAdapter.sendNow）。 */
  sendNow(sender: FrameSender, frame: EventEnvelope): void;
}

/** steward 族命令回口（V2.5 文本管家批：StewardService + EventStream 连接级
 * steward 订阅面——只转发不决策，决策收口 application 层）。 */
export interface StewardCommandDeps {
  /** 管家服务体（ask/confirm LLM 循环 + 确认闸 + 设置面）。 */
  readonly service: StewardService;
  /** EventStream 连接级 steward 订阅面（steward.subscribe/unsubscribe 登记）。 */
  readonly stream: Pick<EventStream, "subscribeSteward" | "unsubscribeSteward" | "sendStewardPendingSnapshot">;
  /** M3-d1 活动账回口（时间线查询/清理——StewardActivityService 窄面；
   *  可选：未装配 = handler 零记忆降级（读面空清单/清理 no-op））。 */
  readonly activity?: Pick<StewardActivityService, "listWindow" | "clear">;
}

/**
 * steward 族命令处理上下文（V2.5 文本管家批）：StewardCommandDeps + 共享
 * 辅助（VoiceCommandContext 同构）。全局命令（信封 sessionId 不消费）——
 * 管家是 daemon 级服务，无会话维。
 */
export interface StewardCommandContext {
  /** 命令来源连接（回执端解析：ws.data.sender ?? rawSender()）。 */
  readonly ws: ServerWebSocket<ConnState>;
  /** 命令类型字面（commandError 回执文案用）。 */
  readonly type: string;
  /** 命令 payload（routeCommand 已解构为 Record）。 */
  readonly payload: Record<string, unknown>;
  /** 管家服务体 + EventStream 订阅面（只转发不决策）。 */
  readonly steward: StewardCommandDeps;
  /** 命令错误回执（语义 = WsServerAdapter.commandError）。 */
  commandError(type: string, code: ConnectionErrorEvent["payload"]["code"], message: string): void;
  /** 构造本连接协议帧发送端（语义 = WsServerAdapter.rawSender）。 */
  rawSender(): FrameSender;
  /** 立即发帧（语义 = WsServerAdapter.sendNow）。 */
  sendNow(sender: FrameSender, frame: EventEnvelope): void;
}

/** surface 族命令回口（M0 表面协议地基批：SurfaceRegistry 注册/归一/路由/
 *  回口——只转发不决策，决策收口 application/surface 层）。 */
export interface SurfaceCommandDeps {
  /** 表面注册表（注册/observe 归一/act 路由/receipt 销账）。 */
  readonly registry: SurfaceRegistry;
}

/**
 * surface 族命令处理上下文（M0 表面协议地基批）：全局命令（信封 sessionId
 * 不消费）——表面是连接级概念，无会话维。
 */
export interface SurfaceCommandContext {
  /** 命令来源连接（回执端解析：ws.data.sender ?? rawSender()）。 */
  readonly ws: ServerWebSocket<ConnState>;
  /** 命令类型字面（commandError 回执文案用）。 */
  readonly type: string;
  /** 命令 payload（routeCommand 已解构为 Record）。 */
  readonly payload: Record<string, unknown>;
  /** 表面注册表（只转发不决策）。 */
  readonly surface: SurfaceCommandDeps;
  /** 命令错误回执（语义 = WsServerAdapter.commandError）。 */
  commandError(type: string, code: ConnectionErrorEvent["payload"]["code"], message: string): void;
  /** 构造本连接协议帧发送端（语义 = WsServerAdapter.rawSender）。 */
  rawSender(): FrameSender;
  /** 立即发帧（语义 = WsServerAdapter.sendNow）。 */
  sendNow(sender: FrameSender, frame: EventEnvelope): void;
}

/** embedding 配置域命令回口（管家记忆 B2：端点 CRUD + 连通测试——只转发
 *  不决策，决策收口 EmbeddingConfigService application 层）。 */
export interface EmbeddingCommandDeps {
  /** embedding 配置域服务体。 */
  readonly service: EmbeddingConfigService;
}

/** 三方平台命令回口（三方平台批：平台 CRUD——只转发不决策，决策收口
 *  CustomProviderService application 层）。 */
export interface ProviderCommandDeps {
  /** 三方平台配置域服务体。 */
  readonly service: CustomProviderService;
}

/**
 * 三方平台命令处理上下文（三方平台批）：全局命令（信封 sessionId
 * 不消费）——配置域无会话维；回执 channel = "provider"。
 */
export interface ProviderCommandContext {
  readonly ws: ServerWebSocket<ConnState>;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly provider: ProviderCommandDeps;
  commandError(type: string, code: ConnectionErrorEvent["payload"]["code"], message: string): void;
  rawSender(): FrameSender;
  sendNow(sender: FrameSender, frame: EventEnvelope): void;
}

/**
 * embedding 配置域命令处理上下文（管家记忆 B2）：全局命令（信封 sessionId
 * 不消费）——配置域无会话维；回执 channel = "embedding"。
 */
export interface EmbeddingCommandContext {
  readonly ws: ServerWebSocket<ConnState>;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly embedding: EmbeddingCommandDeps;
  commandError(type: string, code: ConnectionErrorEvent["payload"]["code"], message: string): void;
  rawSender(): FrameSender;
  sendNow(sender: FrameSender, frame: EventEnvelope): void;
}
