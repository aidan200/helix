/**
 * 命令上下文构造面（WsServerAdapter 依赖注入域拆分）：
 * - WsServerAdapterDeps / McpCommandDeps——适配器依赖接口（组合根注入契约）；
 * - createCommandContexts——十一族命令 context 构造器（routeCommand 逐族
 *   注入依赖面到 handlers/*，只转发不决策，E-19/E-55）。
 *
 * 语义 = 原 WsServerAdapter 同名私有方法，机械迁出零行为差（this.deps →
 * deps；连接绑定回调经 ContextHelpers 注入——commandError/rawSender/
 * sendNow/sessionStamp/snapshotFrame 留守 adapter 连接面）。modelErrorCode
 * 纯函数随迁（无连接态）。
 */
import type { SessionChatPort } from "../../../application/ports/inbound/ChatPort";
import type { SystemPort } from "../../../application/ports/inbound/SystemPort";
import type { AgentOrchestrationPort } from "../../../application/ports/inbound/AgentOrchestrationPort";
import type { SessionDirectoryPort } from "../../../application/ports/inbound/SessionDirectoryPort";
import type { ModelPort } from "../../../application/ports/inbound/ModelPort";
import type { CompactionConfigPort } from "../../../application/ports/outbound/CompactionConfigPort";
import type { SchedulingConfigPort } from "../../../application/ports/outbound/SchedulingConfigPort";
import type { PortConfigPort } from "../../../application/ports/outbound/PortConfigPort";
import type { ResourceConfigPort } from "../../../application/ports/inbound/ResourceConfigPort";
import type { BrowserPort } from "../../../application/ports/outbound/BrowserPort";
import type {
  McpServerConfigInput,
  McpServerPort,
} from "../../../application/ports/outbound/McpServerPort";
import type {
  AgentStateDto,
  ConnectionErrorEvent,
  ErrorCode,
  EventEnvelope,
  SessionSnapshotEvent,
} from "@helix/protocol";
import type { TraceQueryPort } from "../../../domain/trace/TraceQueryPort";
import type { KgBootstrapService } from "../../../application/services/kg/KgBootstrapService";
import type { KgMaintenanceService } from "../../../application/services/kg/KgMaintenanceService";
import type { KgReviewService } from "../../../application/services/kg/KgReviewService";
import type { CodeReviewService } from "../../../application/services/kg/CodeReviewService";
import type { KgViewerService } from "../../../application/services/kg/KgViewerService";
import type { WorkspaceService } from "../../../application/services/workspace/WorkspaceService";
import type { TaskQueryService } from "../../../application/services/task/TaskQueryService";
import type { TaskEnginePort } from "../../../application/ports/inbound/TaskEnginePort";
import type { TurnDiffService, TurnDiffState } from "../../../application/services/TurnDiffService";
import type { ServerWebSocket } from "bun";
import { type FrameSender, EventStream } from "./EventStream";
import type { SessionStateView } from "../../../application/ports/inbound/SessionPort";
import type {
  AgentCommandContext,
  ChatCommandContext,
  DiffCommandContext,
  ConnState,
  KgCommandContext,
  McpCommandContext,
  ResourceCommandContext,
  SessionCommandContext,
  TaskCommandContext,
  TraceCommandContext,
  WebCommandContext,
  WorkspaceCommandContext,
  WsCommandContext,
} from "./handlers/context";

/**
 * mcp 族命令依赖面（mcp 批）：McpServerPort（连接/发现，组合根注入
 * McpRegistry 单例——结构满足，BrowserPort 同构）+ 配置窄写面（组合根
 * 闭包包 writeConfig；readonly → 可变规范化在闭包内，handler 面干净）。
 */
export interface McpCommandDeps {
  readonly registry: McpServerPort;
  /** mcpServers 段整段替换落盘（空数组 → 段省略）。 */
  saveServers(servers: readonly McpServerConfigInput[]): Promise<void>;
}

export interface WsServerAdapterDeps {
  /** 会话路由对话入口（组合根 ChatRouter——按信封 sessionId 分发）。 */
  readonly chat: SessionChatPort;
  /** 会话目录（AD-4：list/loadHistory/delete/草稿/目标解析）。 */
  readonly directory: SessionDirectoryPort;
  readonly system: SystemPort;
  /** 编排入口：agent.kill 终止链回 SchedulerService（只转发不决策）。 */
  readonly orchestration: AgentOrchestrationPort;
  /**
   * 模型/认证管理入口（AD-2）：model 族与 auth 族命令回口（只转发
   * 不决策）。除 model.set（ack = model.changed 广播）外，9 命令结果经
   * *.result 结果帧点对点回执（契约 C §2.2）。
   */
  readonly model: ModelPort;
  /** 压缩参数配置读写面（config 族命令回口；可选——测试缺省回 unimplemented）。 */
  readonly compactionConfig?: CompactionConfigPort;
  readonly schedulingConfig?: SchedulingConfigPort;
  readonly portConfig?: PortConfigPort;
  /**
   * 资源配置面（契约 v0.6）：agent.config 命令族回口（profile kind 维
   * tool/skill 启停 + model 槽位；只转发不决策，AG-12）。
   */
  readonly resource: ResourceConfigPort;
  /**
   * 浏览器连接面（契约 v0.7）：web 族命令回口（web.status 状态读面 /
   * web.stop 停止写面；只转发不决策，AG-12）。状态变更广播不走本面——
   * 组合根 onStatusChange 接线直发 EventStream。
   */
  readonly browser: BrowserPort;
  /**
   * MCP server 管理面（mcp 批）：mcp 族六命令回口（McpServerPort 连接/
   * 发现面 + saveMcpServers 配置窄写面；只转发不决策）。可选：未注入 →
   * 六命令回 command.unimplemented（workspace 先例；stub rig 兼容）。
   */
  readonly mcp?: McpCommandDeps;
  /**
   * 合并目录校验面：agent.config model 型 set 前置校验（窄函数
   * 注入 = catalog.hasModel，ModelService.setModel 先例）。
   */
  readonly hasModel: (modelId: string) => boolean;
  /**
   * kg-writer 派生面恒在工具名（agent-roster 批）：注入 = 组合根
   * SUBAGENT_KG_WRITER_EXTRA_TOOLS 增量常量单源（driving 不得 import
   * driven，窄数据面传递）——list 缺省全量的 system 只读块派生用。
   */
  readonly kgWriterPinnedTools: readonly string[];
  /**
   * base 段系统提示词读面（base prompt 批）：kind → profile 静态声明
   * prompt 全文（五 kind；组合根从五 profile systemPrompt 字段单源注入，
   * driving 不得 import driven，窄数据面传递）——agent.base_prompt.get
   * 命令回口。
   */
  readonly basePrompts: Readonly<Record<string, string>>;
  /**
   * skill 正文读面（skill-content 批）：技能名 → SKILL.md 全文 + 路径
   *（组合根窄函数注入——scan 现拍 + 读文件，driving 不 import driven，
   * basePrompts 同法）——agent.skill_content.get 命令回口。可选：未注入
   *（stub rig）→ 回执「读面未装配」invalid_payload（basePrompts 防御位同构）。
   */
  readonly skillContentOf?: (name: string) => Promise<{ filePath: string; content: string } | undefined>;
  /**
   * 用户级技能创建写面（skills 添加批）：SKILL.md 全文 → SkillCreateOutcome
   *（可选——stub rig 未注入 → handler 回 skipped 防御；skillContentOf 同构）。
   */
  readonly skillCreateOf?: (content: string) => Promise<import("../../../application/ports/outbound/SkillSourcePort").SkillCreateOutcome>;
  /** 事件流（组合根构造并装配进 fan-out 的 EventPublisherPort 实现）。 */
  readonly events: EventStream;
  /** 本次启动生成的 dev token（与 <home>/dev-token 文件内容一致）。 */
  readonly token: string;
  /** 监听端口（0 = 随机；实际端口经 .port 可发现）。 */
  readonly port: number;
  /** 静态产物 handler（组合根注入 driven StaticServe；未配置时缺省）。 */
  readonly staticHandler?: (req: Request) => Promise<Response | null> | Response | null;
  /** 主时间轴尾窗大小（G-1：缺省 30；组合根/测试注入面）。 */
  readonly tailSize?: number;
  /**
   * trace 读面（契约 v0.4 §1）：trace.query 命令回口
   * （只读 domain_events，连接私有读面）；未装配 → command.unimplemented 回执。
   */
  readonly traceQuery?: TraceQueryPort;
  /**
   * kg 数据面（契约 kg-viewer-api 六命令族，§9）：P-1 图谱查看页命令回口
   * （KgViewerService 应用编排，project 参数 service 内单点解析）；
   * 未装配 → command.unimplemented 回执（trace.ts 同模式）。
   * W1 重绑接缝：生产面经 workspace 持有者读现值（重绑后自动跟随）；
   * 直接注入形态保留（stub 测试 rig）。
   */
  readonly kg?: KgViewerService;
  /**
   * kg-bootstrap 数据面（契约 kg-bootstrap-api 五命令，T3.2）：直接注入
   * 形态（stub 测试 rig）；生产面经解析器注入（读 workspace 现值 stack 组装
   * KgBootstrapService——组合根 WeakMap 记忆化，W1 重绑后自动跟随）。
   * 未装配 → command.unimplemented 回执不崩溃（kg.ts 先例）。
   */
  readonly kgBootstrap?: KgBootstrapService | (() => KgBootstrapService | undefined);
  /**
   * kg 维护批数据面（C1，契约 PROTOCOL-CHANGELOG.md §22 两命令）：直接注入形态
   *（stub 测试 rig）；生产面经解析器注入（读 workspace 现值 stack 组装
   * KgMaintenanceService——组合根 WeakMap 记忆化，kgBootstrap 同接缝）。
   * 未装配 → command.unimplemented 回执不崩溃（kg.ts 先例）。
   */
  readonly kgMaintenance?: KgMaintenanceService | (() => KgMaintenanceService | undefined);
  /**
   * kg 评审批数据面（W2-F，契约 PROTOCOL-CHANGELOG.md §23 一命令）：直接注入形态
   *（stub 测试 rig）；生产面经解析器注入（读 workspace 现值 stack 组装
   * KgReviewService——组合根 WeakMap 记忆化，kgBootstrap 同接缝）。
   * 未装配 → command.unimplemented 回执不崩溃（kg.ts 先例）。
   */
  readonly kgReview?: KgReviewService | (() => KgReviewService | undefined);
  /** code-review 批回口（code-review v1.5：CodeReviewService——组合根
   *  WeakMap 记忆化，kgReview 同接缝）。未装配 → command.unimplemented。 */
  readonly codeReview?: CodeReviewService | (() => CodeReviewService | undefined);
  /**
   * workspace 绑定面（W1 绑定闭环）：WorkspaceService（绑定状态机唯一
   * 事实源）——kg 栈持有者读面 + unbound 防御判别 + workspace 族命令回口
   * + 会话创建门禁。缺省未装配（stub 测试形态：kg 直接注入 + 门禁缺省
   * 视为已绑定 + workspace 族不分发）。
   */
  readonly workspace?: WorkspaceService;
  /**
   * P-2 任务页读面（契约 task-api 九命令族，§8.1）：TaskQueryService
   *（AD-4② 人类可读投影服务端组装）；未装配 → command.unimplemented
   *（kg.ts 先例）。task.subscribe 订阅面同门（数据面关闭时订阅无意义）。
   */
  readonly taskQuery?: TaskQueryService;
  /**
   * P-2 任务页生命周期写面：TaskEnginePort（只转发不决策——状态判断收口
   * 引擎 T1.3，task.invalid_state 透传；task.changed 广播在 handler/
   * EventStream 层接线，O-7）；未装配 → command.unimplemented。
   */
  readonly taskEngine?: TaskEnginePort;
  /**
   * T3 diff 查询面（diff.get 命令回口）：热会话 diff 状态读面
   * （registry.peek().diff）+ TurnDiffService 查询操作面；未装配 →
   * command.unimplemented（task/kg 族先例）。
   */
  readonly diff?: {
    readonly stateOf: (sessionId: string) => TurnDiffState | undefined;
    readonly service: TurnDiffService;
  };
}

/**
 * 连接绑定共享辅助面（语义 = WsServerAdapter 同名私有方法，机械转发零行为差）：
 * context 构造器需要的六个回调——错误回执/帧发送/快照盖章链留守 adapter
 * 连接面（握手与事件流共用），经本接口注入。
 */
export interface ContextHelpers {
  commandError(
    ws: ServerWebSocket<ConnState>,
    type: string,
    code: ConnectionErrorEvent["payload"]["code"],
    message: string,
  ): void;
  rawSender(ws: ServerWebSocket<ConnState>): FrameSender;
  sendNow(sender: FrameSender, frame: EventEnvelope): void;
  sessionStamp(view: SessionStateView): { model: string; agentState: AgentStateDto };
  snapshotFrame(view: SessionStateView, model: string, agentState: AgentStateDto): SessionSnapshotEvent;
}

/**
 * 模型/认证命令错误映射（契约 C §4 语义；专用错误码微批已登记）：
 * ModelNotFoundError → model_not_found；ProviderNotFoundError →
 * provider_not_found；会话不存在 → session.not_found（既有）。
 * catalog/catalog_refresh 通路另用 catalog_unreachable（拉取失败）。
 * 判别改 err.code 码匹配（原 err.name 字符串比对；无 code 旧
 * 对象 → 兑底 command.invalid_payload，与原兑底等价）。
 */
export function modelErrorCode(err: Error): ConnectionErrorEvent["payload"]["code"] {
  const code = (err as { code?: ErrorCode }).code;
  if (code === "session.not_found") return "session.not_found";
  if (code === "model_not_found") return "model_not_found";
  if (code === "provider_not_found") return "provider_not_found";
  return "command.invalid_payload";
}

/** 十一族命令 context 构造器（routeCommand 分发用；只组装不决策）。 */
export function createCommandContexts(deps: WsServerAdapterDeps, helpers: ContextHelpers) {
  const commandContext = (
    ws: ServerWebSocket<ConnState>,
    type: string,
    payload: Record<string, unknown>,
    envelope: { sessionId?: unknown },
  ): WsCommandContext => {
    return {
      ws,
      type,
      payload,
      envelope,
      model: deps.model,
      compactionConfig: deps.compactionConfig,
      schedulingConfig: deps.schedulingConfig,
      portConfig: deps.portConfig,
      system: deps.system,
      commandError: (cmdType, code, message) => helpers.commandError(ws, cmdType, code, message),
      modelErrorCode: (err) => modelErrorCode(err),
      rawSender: () => helpers.rawSender(ws),
      sendNow: (sender, frame) => helpers.sendNow(sender, frame),
    };
  };

  /**
   * chat 族命令处理上下文（AD-1，同 commandContext 模式）：ChatPort
   * + SessionDirectoryPort（草稿建会话链）+ EventStream（建会话订阅）+
   * 快照盖章链回调（sessionStamp/snapshotFrame 留本类，机械转发零行为差）。
   */
  const chatContext = (
    ws: ServerWebSocket<ConnState>,
    type: string,
    payload: Record<string, unknown>,
    envelope: { sessionId?: unknown },
  ): ChatCommandContext => {
    return {
      ws,
      type,
      payload,
      envelope,
      chat: deps.chat,
      directory: deps.directory,
      events: deps.events,
      sessionStamp: (view) => helpers.sessionStamp(view),
      snapshotFrame: (view, model, agentState) => helpers.snapshotFrame(view, model, agentState),
      // W1 绑定闭环：草稿建会话门禁判别面（未装配 workspace 面时缺省视为已绑定）
      ...(deps.workspace !== undefined ? { workspaceBound: () => deps.workspace!.isBound() } : {}),
      commandError: (cmdType, code, message) => helpers.commandError(ws, cmdType, code, message),
      sendNow: (sender, frame) => helpers.sendNow(sender, frame),
    };
  };

  /**
   * session 族命令处理上下文（AD-1）：SessionDirectoryPort（目录/视图/
   * 删除/目标解析）+ EventStream 订阅面 + 快照盖章链回调 + 共享辅助。
   */
  const sessionContext = (
    ws: ServerWebSocket<ConnState>,
    type: string,
    payload: Record<string, unknown>,
    envelope: { sessionId?: unknown },
  ): SessionCommandContext => {
    return {
      ws,
      type,
      payload,
      envelope,
      directory: deps.directory,
      events: deps.events,
      sessionStamp: (view) => helpers.sessionStamp(view),
      snapshotFrame: (view, model, agentState) => helpers.snapshotFrame(view, model, agentState),
      commandError: (cmdType, code, message) => helpers.commandError(ws, cmdType, code, message),
      rawSender: () => helpers.rawSender(ws),
      sendNow: (sender, frame) => helpers.sendNow(sender, frame),
    };
  };

  /** agent 族命令处理上下文（AD-1）：AgentOrchestrationPort + EventStream 实例订阅。 */
  const agentContext = (
    ws: ServerWebSocket<ConnState>,
    type: string,
    payload: Record<string, unknown>,
  ): AgentCommandContext => {
    return {
      ws,
      type,
      payload,
      orchestration: deps.orchestration,
      events: deps.events,
      commandError: (cmdType, code, message) => helpers.commandError(ws, cmdType, code, message),
    };
  };

  /** trace 族命令处理上下文（AD-1）：trace 读面（未装配 → undefined，handler 回 command.unimplemented）。 */
  const traceContext = (
    ws: ServerWebSocket<ConnState>,
    type: string,
    payload: Record<string, unknown>,
  ): TraceCommandContext => {
    return {
      ws,
      type,
      payload,
      traceQuery: deps.traceQuery,
      commandError: (cmdType, code, message) => helpers.commandError(ws, cmdType, code, message),
      rawSender: () => helpers.rawSender(ws),
      sendNow: (sender, frame) => helpers.sendNow(sender, frame),
    };
  };

  /**
   * kg 族命令处理上下文（§9 六命令族）：KgViewerService 应用编排面
   * （未装配 → undefined，handler 回 command.unimplemented——trace.ts 先例）
   * + 共享辅助（本连接绑定，语义 = 本类同名私有方法，机械转发零行为差）。
   * W1 重绑接缝：生产面 kg 经 workspace 持有者读现值（重绑后自动跟随）；
   * workspaceUnbound = 防御契约判别（空集结果非报错）。
   */
  const kgContext = (
    ws: ServerWebSocket<ConnState>,
    type: string,
    payload: Record<string, unknown>,
  ): KgCommandContext => {
    return {
      ws,
      type,
      payload,
      kg: deps.kg ?? deps.workspace?.stack()?.viewerService,
      bootstrap:
        deps.kgBootstrap === undefined
          ? undefined
          : typeof deps.kgBootstrap === "function"
            ? deps.kgBootstrap()
            : deps.kgBootstrap,
      maintenance:
        deps.kgMaintenance === undefined
          ? undefined
          : typeof deps.kgMaintenance === "function"
            ? deps.kgMaintenance()
            : deps.kgMaintenance,
      review:
        deps.kgReview === undefined
          ? undefined
          : typeof deps.kgReview === "function"
            ? deps.kgReview()
            : deps.kgReview,
      codeReview:
        deps.codeReview === undefined
          ? undefined
          : typeof deps.codeReview === "function"
            ? deps.codeReview()
            : deps.codeReview,
      workspaceUnbound: deps.workspace !== undefined && !deps.workspace.isBound(),
      commandError: (cmdType, code, message) => helpers.commandError(ws, cmdType, code, message),
      rawSender: () => helpers.rawSender(ws),
      sendNow: (sender, frame) => helpers.sendNow(sender, frame),
    };
  };

  /**
   * workspace 族命令处理上下文（W1 绑定闭环）：WorkspaceService 绑定
   * 状态机（get 快照/open 写面）+ 共享辅助（本连接绑定，语义 = 本类同名
   * 私有方法，机械转发零行为差）。无 payload 形状消费在 get；open 的
   * payload.root 形状校验在 handler 入口。
   */
  const workspaceContext = (
    ws: ServerWebSocket<ConnState>,
    type: string,
    payload: Record<string, unknown> = {},
  ): WorkspaceCommandContext => {
    const workspace = deps.workspace!;
    return {
      ws,
      type,
      payload,
      workspace,
      commandError: (cmdType, code, message) => helpers.commandError(ws, cmdType, code, message),
      rawSender: () => helpers.rawSender(ws),
      sendNow: (sender, frame) => helpers.sendNow(sender, frame),
    };
  };

  /**
   * agent.config 族命令处理上下文（契约 v0.6）：ResourceConfigPort
   * + 合并目录（model 型 hasModel 前置校验）+ EventStream（changed 广播）
   * + 共享辅助（本连接绑定，语义 = 本类同名私有方法，机械转发零行为差）。
   */
  const resourceContext = (
    ws: ServerWebSocket<ConnState>,
    type: string,
    payload: Record<string, unknown>,
  ): ResourceCommandContext => {
    return {
      ws,
      type,
      payload,
      resource: deps.resource,
      hasModel: deps.hasModel,
      kgWriterPinnedTools: deps.kgWriterPinnedTools,
      basePrompts: deps.basePrompts,
      skillContentOf: deps.skillContentOf ?? (() => Promise.resolve(undefined)), // 未装配（stub rig）→ handler 回「未知技能名或正文不可读」防御
      skillCreateOf: deps.skillCreateOf,
      events: deps.events,
      commandError: (cmdType, code, message) => helpers.commandError(ws, cmdType, code, message),
      rawSender: () => helpers.rawSender(ws),
      sendNow: (sender, frame) => helpers.sendNow(sender, frame),
    };
  };

  /**
   * task 族命令处理上下文（P-2 九命令族，§8.1）：TaskQueryService 读面 +
   * TaskEnginePort 生命周期写面（未装配 → undefined，handler 回
   * command.unimplemented——kg.ts 先例）+ EventStream（连接级任务订阅表 +
   * task.changed 广播）+ 共享辅助（本连接绑定，语义 = 本类同名私有方法，
   * 机械转发零行为差）。
   */
  const taskContext = (
    ws: ServerWebSocket<ConnState>,
    type: string,
    payload: Record<string, unknown>,
  ): TaskCommandContext => {
    return {
      ws,
      type,
      payload,
      taskQuery: deps.taskQuery,
      taskEngine: deps.taskEngine,
      events: deps.events,
      commandError: (cmdType, code, message) => helpers.commandError(ws, cmdType, code, message),
      rawSender: () => helpers.rawSender(ws),
      sendNow: (sender, frame) => helpers.sendNow(sender, frame),
    };
  };

  /**
   * diff 族命令处理上下文（T3+T4 轮次 diff 协议与 UI 闭环，第十一族）：
   * 查询面（registry peek + TurnDiffService）+ 共享辅助（会话作用域——
   * sessionId 路由位在信封，handler 内校验必填）。
   */
  const diffContext = (
    ws: ServerWebSocket<ConnState>,
    type: string,
    payload: Record<string, unknown>,
    envelope: { sessionId?: unknown },
  ): DiffCommandContext => {
    return {
      ws,
      type,
      payload,
      envelope,
      diff: deps.diff,
      commandError: (cmdType, code, message) => helpers.commandError(ws, cmdType, code, message),
      rawSender: () => helpers.rawSender(ws),
      sendNow: (sender, frame) => helpers.sendNow(sender, frame),
    };
  };

  /**
   * web 族命令处理上下文（契约 v0.7）：BrowserPort（状态读面/停止写面）
   * + 共享辅助（本连接绑定，语义 = 本类同名私有方法，机械转发零行为差）。
   * 无 payload 消费（web.status / web.stop 均无参），上下文不携带 payload。
   */
  const webContext = (
    ws: ServerWebSocket<ConnState>,
    type: string,
  ): WebCommandContext => {
    return {
      ws,
      type,
      browser: deps.browser,
      commandError: (cmdType, code, message) => helpers.commandError(ws, cmdType, code, message),
      rawSender: () => helpers.rawSender(ws),
      sendNow: (sender, frame) => helpers.sendNow(sender, frame),
    };
  };

  /**
   * mcp 族命令处理上下文（mcp 批）：McpServerPort + 配置窄写面 + 共享
   * 辅助（本连接绑定，语义 = 本类同名私有方法，机械转发零行为差；
   * webContext 同构 + payload 携带）。未装配（deps.mcp undefined）在
   * routeCommand 已拒，此处非空断言安全。
   */
  const mcpContext = (
    ws: ServerWebSocket<ConnState>,
    type: string,
    payload: Record<string, unknown>,
  ): McpCommandContext => {
    const mcp = deps.mcp!; // routeCommand 已拒绝未装配（同 workspace 先例的前置判空）
    return {
      ws,
      type,
      payload,
      mcp: mcp.registry,
      saveMcpServers: (servers) => mcp.saveServers(servers), // async 链（TR-106 纪律 4：落盘先于连接）
      commandError: (cmdType, code, message) => helpers.commandError(ws, cmdType, code, message),
      rawSender: () => helpers.rawSender(ws),
      sendNow: (sender, frame) => helpers.sendNow(sender, frame),
    };
  };

  return {
    commandContext,
    chatContext,
    sessionContext,
    agentContext,
    traceContext,
    kgContext,
    workspaceContext,
    resourceContext,
    taskContext,
    diffContext,
    webContext,
    mcpContext,
  };
}
