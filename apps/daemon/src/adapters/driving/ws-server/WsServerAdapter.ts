/**
 * WsServerAdapter —— WS 驱动侧（architecture.md §3.5）。
 *
 * Bun.serve({ hostname: "127.0.0.1", port, websocket }) 原生实现，零新依赖：
 * - HTTP 面：GET /helix-dev-token（浏览器侧 token 获取通道，loopback Origin
 *   反射，见 PROTOCOL.md §9）+ 前端静态产物（组合根注入 driven StaticServe
 *   的 handler，driving 不 import driven——AG-02③）；
 * - WS 面：hello 握手 token 校验（三分支拒绝：发 error 帧后 close）→
 *   welcome + 立即推 session.snapshot（重连恢复 = 快照+增量，AD-16；
 * 当前会话命中零条目内存草稿 → welcome.draft + 不 attach 不推快照）→
 * 命令帧路由到 inbound port（只转发不决策，AG-12）→
 *   事件经 EventStream（EventPublisherPort 实现）下发。
 *
 * 会话作用域命令按信封 sessionId 路由（AD-4 多会话：缺省 = 当前
 * 会话，v0/v0.1 兼容）经 SessionDirectoryPort/SessionChatPort 解析目标会话；
 * session 族命令（list/loadHistory/delete）+ 草稿建会话链（chat.send 信封
 * 省略 sessionId + payload.draft=true，契约 B §1.5）在此落地；握手 welcome
 * 快照升级为「当前订阅会话」（当前会话 = 注册表最近活跃会话）。
 *
 * 结果帧微批：model/auth 9 命令结果改点对点 *.result 结果帧
 * sendNow 直发（契约 C §2.2，与 session 族结果帧同构；model.set 的 ack
 * 仍为 model.changed 广播不动）；错误分支启用专用错误码（契约 C §4）。
 *
 * model 族 6 case + auth 族 4 case 的 case 体机械迁出 handlers/{model,auth}.ts（AD-3 handler 模块化）
 * 机械迁出 handlers/{model,auth}.ts（语义逐字节等价）；routeCommand 对应
 * case 一行转发（commandContext 供出依赖面：ModelPort + system.getStatus()
 * 缺省回退 + 4 个共享辅助）。
 *
 * 其余 12 case（chat/session/agent/trace 族）case 体机械迁出（handler 化收口 + 解环）
 * agent/trace 族）case 体机械迁出 handlers/{chat,session,agent,trace}.ts
 * （语义逐字节等价；traceInstanceRecordToDto / resolveTargetSession 随族
 * 迁出）；routeCommand 全 22 case 一行转发；族上下文类型承 handlers/
 * context.ts（kg 族六命令同构接入：handlers/kg.ts + kgContext，P-1 §9；
 * routeCommand 全 28 case 一行转发）；
 * context.ts（ConnState/WsCommandContext 上收，三模块环解）；
 * sessionStamp/snapshotFrame 盖章链留本类，session/chat handler 经上下文
 * 回调机械引用零行为差（不为省行数造成第二份）。
 * task 族九命令同构接入（iter-20260829-ys7q T1.5，P-2 任务页数据面，
 * §8.1；handlers/task.ts + taskContext：TaskQueryService 读面 +
 * TaskEnginePort 生命周期回口，task.changed 广播在 EventStream/handler 层
 * 接线，O-7）；routeCommand 全 45 case 一行转发。
 *
 * 绑定纪律：仅 127.0.0.1，禁止 0.0.0.0/::——构造期即钉死。
 */
import type { SessionChatPort } from "../../../application/ports/inbound/ChatPort";
import type { SystemPort } from "../../../application/ports/inbound/SystemPort";
import type { AgentOrchestrationPort } from "../../../application/ports/inbound/AgentOrchestrationPort";
import type { SessionDirectoryPort } from "../../../application/ports/inbound/SessionDirectoryPort";
import type { ModelPort } from "../../../application/ports/inbound/ModelPort";
import type { CompactionConfigPort } from "../../../application/ports/outbound/CompactionConfigPort";
import type { ResourceConfigPort } from "../../../application/ports/inbound/ResourceConfigPort";
import type { BrowserPort } from "../../../application/ports/outbound/BrowserPort";
import type {
  AgentStateDto,
  ConnectionErrorEvent,
  ConnectionWelcomeEvent,
  ErrorCode,
  EventEnvelope,
  FrameVersion,
  SessionSnapshotEvent,
} from "@helix/protocol";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import type { TraceQueryPort } from "../../../domain/trace/TraceQueryPort";
import type { KgBootstrapService } from "../../../application/services/kg/KgBootstrapService";
import type { KgMaintenanceService } from "../../../application/services/kg/KgMaintenanceService";
import type { KgReviewService } from "../../../application/services/kg/KgReviewService";
import type { KgViewerService } from "../../../application/services/kg/KgViewerService";
import type { WorkspaceService } from "../../../application/services/workspace/WorkspaceService";
import type { TaskQueryService } from "../../../application/services/task/TaskQueryService";
import type { TaskEnginePort } from "../../../application/ports/inbound/TaskEnginePort";
// AG-12：ws-server 对 domain 仅 type-only——normalize 校验收口在 driven
// adapter 入口（architecture.md §3.5b「调仓储前」）
import type { ServerWebSocket } from "bun";
import { EventStream, type FrameSender } from "./EventStream";
import { toSnapshotDto, TAIL_WINDOW_SIZE } from "./DtoMapper";
import type { SessionStateView } from "../../../application/ports/inbound/SessionPort";
import type {
  AgentCommandContext,
  ChatCommandContext,
  ConnState,
  KgCommandContext,
  ResourceCommandContext,
  SessionCommandContext,
  TaskCommandContext,
  TraceCommandContext,
  WebCommandContext,
  WorkspaceCommandContext,
  WsCommandContext,
} from "./handlers/context";
import {
  handleAgentKill,
  handleAgentSubscribe,
  handleAgentUnsubscribe,
} from "./handlers/agent";
import { handleChatAbort, handleChatSend, handleChatSteer } from "./handlers/chat";
import {
  handleSessionDelete,
  handleSessionLoadHistory,
  handleSessionList,
  handleSessionSubscribe,
  handleSessionUnsubscribe,
} from "./handlers/session";
import { handleTraceQuery } from "./handlers/trace";
import {
  handleKgBootstrapCreate,
  handleKgBootstrapImpact,
  handleKgBootstrapProduce,
  handleKgChangeReport,
  handleKgGraphPurge,
  handleKgHealth,
  handleKgIndexDelete,
  handleKgIndexStatus,
  handleKgList,
  handleKgNodeConfirm,
  handleKgNodeDetail,
  handleKgProjects,
  handleKgReviewCreate,
  handleKgNodeSupersede,
  handleKgNodeUpdate,
} from "./handlers/kg";
import { handleAgentConfigList, handleAgentConfigSetEnabled } from "./handlers/resource";
import { handleWebStart, handleWebStatus, handleWebStop } from "./handlers/web";
import {
  handleModelCatalog,
  handleModelCatalogRefresh,
  handleModelGet,
  handleModelGetDefault,
  handleModelSet,
  handleModelSetDefault,
  handleModelSetThinkingDefault,
} from "./handlers/model";
import { handleConfigGetCompaction, handleConfigSetCompaction } from "./handlers/config";
import { handleThinkingSet } from "./handlers/thinking";
import { handleWorkspaceGet, handleWorkspaceOpen } from "./handlers/workspace";
import {
  handleTaskArtifacts,
  handleTaskCancel,
  handleTaskDelete,
  handleTaskDetail,
  handleTaskList,
  handleTaskPause,
  handleTaskResume,
  handleTaskSubscribe,
  handleTaskUnsubscribe,
} from "./handlers/task";
import {
  handleAuthDeleteKey,
  handleAuthList,
  handleAuthSetKey,
  handleAuthVerify,
} from "./handlers/auth";

/** 浏览器侧 token 获取端点路径（vite dev 与 static-serve 生产共用同一机制）。 */
export const DEV_TOKEN_PATH = "/helix-dev-token";

/** 信任源族：①loopback 开发 Origin（vite dev 等）：localhost / 127.0.0.1 /
 *  [::1] 任意端口；②打包形态应用自有资产协议源：tauri://localhost
 *  （macOS/Linux）与 http(s)://tauri.localhost（Windows）——该协议/主机仅
 *  本应用的 webview 可用（OS 注册专属），信任级不低于 loopback http
 *  （任一本地进程都可 serve loopback http，而 tauri 源只有本应用能开）。
 *  打包前端由此取 token（W6m 实证：缺此两款 → 打包形态永远卡在
 *  「正在连接 daemon…」——token 403，握手无法发起）。 */
const LOOPBACK_ORIGIN_RE =
  /^(?:https?:\/\/(?:localhost|127\.0\.0\.1|\[::1])(?::\d+)?|https?:\/\/tauri\.localhost|tauri:\/\/localhost)$/i;

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
   * kg 维护批数据面（C1，契约 PROTOCOL.md §22 两命令）：直接注入形态
   *（stub 测试 rig）；生产面经解析器注入（读 workspace 现值 stack 组装
   * KgMaintenanceService——组合根 WeakMap 记忆化，kgBootstrap 同接缝）。
   * 未装配 → command.unimplemented 回执不崩溃（kg.ts 先例）。
   */
  readonly kgMaintenance?: KgMaintenanceService | (() => KgMaintenanceService | undefined);
  /**
   * kg 评审批数据面（W2-F，契约 PROTOCOL.md §23 一命令）：直接注入形态
   *（stub 测试 rig）；生产面经解析器注入（读 workspace 现值 stack 组装
   * KgReviewService——组合根 WeakMap 记忆化，kgBootstrap 同接缝）。
   * 未装配 → command.unimplemented 回执不崩溃（kg.ts 先例）。
   */
  readonly kgReview?: KgReviewService | (() => KgReviewService | undefined);
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
}

export class WsServerAdapter {
  private readonly deps: WsServerAdapterDeps;
  private readonly server: Bun.Server<ConnState>;

  constructor(deps: WsServerAdapterDeps) {
    this.deps = deps;
    this.server = Bun.serve<ConnState>({
      hostname: "127.0.0.1", // 仅回环监听（结构保证非 loopback 不可达）
      port: deps.port,
      fetch: (req, srv) => this.onFetch(req, srv),
      websocket: {
        open: (ws) => this.onOpen(ws),
        message: (ws, data) => this.onMessage(ws, data),
        close: (ws) => this.onClose(ws),
      },
    });
  }

  /** 实际监听地址（测试断言源）。 */
  get hostname(): string {
    return this.server.hostname ?? "127.0.0.1";
  }

  /** 实际监听端口（port=0 随机分配后的发现面，test-design §5.4）。 */
  get port(): number {
    return this.server.port ?? 0;
  }

  /** WS 端点 URL（启动日志/文档用）。 */
  get url(): string {
    return `ws://${this.server.hostname}:${this.server.port}`;
  }

  /** 停止服务（daemon 优雅关闭：立即关闭活动连接）。 */
  stop(): void {
    this.server.stop(true);
  }

  // ── HTTP 面 ─────────────────────────────────────────────────

  private async onFetch(req: Request, srv: Bun.Server<ConnState>): Promise<Response | undefined> {
    // ① WS 升级（非升级请求返回 false，继续 HTTP 路径）
    if (srv.upgrade(req, { data: { authed: false, sender: null } satisfies ConnState })) {
      return undefined;
    }

    const url = new URL(req.url);

    // ② 浏览器侧 token 获取端点（仅回环监听 + loopback Origin 反射，PROTOCOL.md §9）
    if (req.method === "GET" && url.pathname === DEV_TOKEN_PATH) {
      return this.devTokenResponse(req);
    }

    // ③ 前端静态产物（driven StaticServe，未配置/未命中由 handler 表达）
    if (this.deps.staticHandler) {
      const resp = await this.deps.staticHandler(req);
      if (resp) return resp;
    }

    return new Response("Not Found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  private devTokenResponse(req: Request): Response {
    const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8" };
    const origin = req.headers.get("origin");
    if (origin !== null) {
      // 浏览器 fetch 受 CORS 约束：仅反射 loopback 开发 Origin（vite dev 等），
      // 外部站点 Origin 拒绝（防任意网页窃取 token 接管本机 agent）。
      if (!LOOPBACK_ORIGIN_RE.test(origin)) {
        return new Response("Forbidden\n", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      headers["access-control-allow-origin"] = origin;
    }
    return new Response(this.deps.token, { headers });
  }

  // ── WS 面 ───────────────────────────────────────────────────

  private onOpen(ws: ServerWebSocket<ConnState>): void {
    ws.data.authed = false;
    ws.data.sender = null;
  }

  private onClose(ws: ServerWebSocket<ConnState>): void {
    if (ws.data.sender) this.deps.events.detach(ws.data.sender);
  }

  private onMessage(ws: ServerWebSocket<ConnState>, data: string | Buffer): void {
    let envelope: { v: FrameVersion | number | string; type: unknown; payload: unknown; sessionId?: unknown };
    try {
      envelope = JSON.parse(String(data));
    } catch {
      ws.close(); // 非 JSON 帧 = 连接层垃圾数据（契约 §7：不发帧直接 close）
      return;
    }
    if (!ws.data.authed) {
      void this.handleHandshake(ws, envelope);
      return;
    }
    this.routeCommand(ws, envelope);
  }

  // ── 握手（三分支） ──────────────────────────────────

  private async handleHandshake(
    ws: ServerWebSocket<ConnState>,
    envelope: { v: FrameVersion | number | string; type: unknown; payload: unknown },
  ): Promise<void> {
    const reject = (code: ConnectionErrorEvent["payload"]["code"], message: string): void => {
      this.sendNow(this.rawSender(ws), {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "notification",
        type: "connection.error",
        payload: { code, message },
      });
      ws.close(); // error 帧先入发送队列，close 控制帧随后（契约 §2：先发帧再 close）
    };

    // 首帧必须是 hello（非 hello = 未出示 token）
    const payload = (envelope.type === "hello" ? envelope.payload : undefined) as
      | { token?: unknown; protocolVersion?: unknown }
      | undefined;

    if (payload === undefined || typeof payload.token !== "string" || payload.token === "") {
      reject("auth.missing_token", "握手缺少 token（首帧应为携带 token 的 hello）");
      return;
    }
    if (payload.token !== this.deps.token) {
      reject("auth.invalid_token", "dev token 不符");
      return;
    }
    if (envelope.v !== PROTOCOL_VERSION || payload.protocolVersion !== PROTOCOL_VERSION) {
      reject("protocol.version_unsupported", `协议版本不支持：服务端 v${PROTOCOL_VERSION}`);
      return;
    }

    // 通过：注册事件流 + welcome（命中零条目内存草稿 → welcome.draft +
    // 不 attach 会话不推快照——attach() 无参注册连接，draft 链 subscribeSession
    // 仍可用；残骸清理由 probeCurrentDraft 侧完成，getStatus 取清理后现值）
    ws.data.authed = true;
    const sender = this.rawSender(ws);
    ws.data.sender = sender;
    const isDraft = (await this.deps.directory.probeCurrentDraft?.()) ?? false;
    const status = this.deps.system.getStatus();
    if (isDraft) {
      this.deps.events.attach(sender); // 注册连接但不订阅草稿会话（草稿态无可推增量）
    } else {
      // 定稿：默认订阅「当前订阅会话」= 注册表当前会话（冷则懒加载）
      this.deps.events.attach(sender, status.sessionId);
    }

    const agentState = status.agentState as AgentStateDto;
    const model = status.model ?? "";
    // P1 T3：welcome 回带 mode = 当前会话定格值（非草稿分支；与快照同源
    // view——提前组装共享，零额外成本。快照组装失败降级不携带，welcome
    // 必达语义不变，读侧按 default 兜底；草稿态不携带（草稿模式纯前端态，
    // daemon 不知情——P1 取舍，前端回落 default）。
    let view: SessionStateView | undefined;
    if (!isDraft) {
      try {
        view = await this.deps.directory.getSessionView(status.sessionId);
      } catch (err) {
        console.warn(`[ws] 握手快照组装失败（会话 ${status.sessionId}）：${(err as Error).message}`);
      }
    }
    const welcome: ConnectionWelcomeEvent = {
      v: PROTOCOL_VERSION,
      sessionId: SYSTEM_SESSION_ID, // 会话无关系统事件（notification 通道，契约 A §3）
      channel: "notification",
      type: "connection.welcome",
      payload: {
        sessionId: status.sessionId,
        model,
        agentState,
        ...(isDraft ? { draft: true } : {}),
        ...(view?.session.mode !== undefined ? { mode: view.session.mode } : {}),
      },
    };
    this.sendNow(sender, welcome);
    if (isDraft) return; // 草稿握手不推快照（前端按草稿态显示；建会话链另推）
    if (view !== undefined) this.sendNow(sender, this.snapshotFrame(view, model, agentState));
  }

  /** session.snapshot 帧（v0.2 章印：sessionId = 会话归属 + channel=session；AD-1 尾窗口径）。 */
  private snapshotFrame(view: SessionStateView, model: string, agentState: AgentStateDto): SessionSnapshotEvent {
    return {
      v: PROTOCOL_VERSION,
      sessionId: view.session.sessionId,
      channel: "session",
      type: "session.snapshot",
      payload: {
        snapshot: toSnapshotDto(view, model, agentState, { tailSize: this.deps.tailSize ?? TAIL_WINDOW_SIZE }),
      },
    };
  }

  /**
   * per-session 快照盖章（热修）：agentState/model 取视图归属会话自身
   * （注册表 buildView 随视图同源组装）；model 缺省（引擎未暴露）回退全局
   * 默认——与 getStatus() 回退口径一致（container.ts defaultModel.current()
   * ≡ ModelPort.getDefault() SQLite 读面）。禁止改用 system.getStatus()：
   * 那是全局最近活跃投影，多会话下与快照本体错配（串台根因）。
   */
  private sessionStamp(view: SessionStateView): { model: string; agentState: AgentStateDto } {
    return {
      model: view.model ?? this.deps.model.getDefault().model,
      agentState: (view.agentState ?? "idle") as AgentStateDto,
    };
  }

  // ── 命令路由（只转发不决策） ───────────────────────

  private routeCommand(
    ws: ServerWebSocket<ConnState>,
    envelope: { v: FrameVersion | number | string; type: unknown; payload: unknown; sessionId?: unknown },
  ): void {
    const type = typeof envelope.type === "string" ? envelope.type : "";
    const payload = (envelope.payload ?? {}) as Record<string, unknown>;

    switch (type) {
      // ── chat 族（AD-1：case 体机械迁出 handlers/chat.ts，此处一行转发）──
      case "chat.send":
        return handleChatSend(this.chatContext(ws, type, payload, envelope));
      case "chat.steer":
        return handleChatSteer(this.chatContext(ws, type, payload, envelope));
      case "chat.abort":
        return handleChatAbort(this.chatContext(ws, type, payload, envelope));
      // ── session 族（契约 B §1；AD-1 迁出 handlers/session.ts）──
      case "session.subscribe":
        return handleSessionSubscribe(this.sessionContext(ws, type, payload, envelope));
      case "session.unsubscribe":
        return handleSessionUnsubscribe(this.sessionContext(ws, type, payload, envelope));
      case "session.list":
        return handleSessionList(this.sessionContext(ws, type, payload, envelope));
      case "session.loadHistory":
        return handleSessionLoadHistory(this.sessionContext(ws, type, payload, envelope));
      case "session.delete":
        return handleSessionDelete(this.sessionContext(ws, type, payload, envelope));
      // ── v0.1 编排命令（契约 §4；AD-1 迁出 handlers/agent.ts）──
      case "agent.kill":
        return handleAgentKill(this.agentContext(ws, type, payload));
      case "agent.subscribe":
        return handleAgentSubscribe(this.agentContext(ws, type, payload));
      case "agent.unsubscribe":
        return handleAgentUnsubscribe(this.agentContext(ws, type, payload));
      // ── v0.4 trace 族（契约 v0.4 §1；AD-1 迁出 handlers/trace.ts）──
      case "trace.query":
        return handleTraceQuery(this.traceContext(ws, type, payload));
      // ── kg 族（P-1 六命令族，契约 kg-viewer-api，§9；handlers/kg.ts）──
      case "kg.projects":
        return handleKgProjects(this.kgContext(ws, type, payload));
      case "kg.list":
        return handleKgList(this.kgContext(ws, type, payload));
      case "kg.node.detail":
        return handleKgNodeDetail(this.kgContext(ws, type, payload));
      case "kg.change.report":
        return handleKgChangeReport(this.kgContext(ws, type, payload));
      case "kg.node.confirm":
        return handleKgNodeConfirm(this.kgContext(ws, type, payload));
      case "kg.index.status":
        return handleKgIndexStatus(this.kgContext(ws, type, payload));
      // ── kg-bootstrap 批（T3.2，契约 kg-bootstrap-api；handlers/kg.ts）──
      case "kg.bootstrap.create":
        return handleKgBootstrapCreate(this.kgContext(ws, type, payload));
      case "kg.bootstrap.produce":
        return handleKgBootstrapProduce(this.kgContext(ws, type, payload));
      case "kg.node.update":
        return handleKgNodeUpdate(this.kgContext(ws, type, payload));
      case "kg.node.supersede":
        return handleKgNodeSupersede(this.kgContext(ws, type, payload));
      case "kg.bootstrap.impact":
        return handleKgBootstrapImpact(this.kgContext(ws, type, payload));
      // ── kg 维护批（C1，契约 PROTOCOL.md §22；handlers/kg.ts）──
      case "kg.graph.purge":
        return handleKgGraphPurge(this.kgContext(ws, type, payload));
      case "kg.index.delete":
        return handleKgIndexDelete(this.kgContext(ws, type, payload));
      // ── kg.health 批（W2-E 轨一体检看板；handlers/kg.ts）──
      case "kg.health":
        return handleKgHealth(this.kgContext(ws, type, payload));
      // ── kg 评审批（W2-F 轨二体检任务发起；handlers/kg.ts）──
      case "kg.review.create":
        return handleKgReviewCreate(this.kgContext(ws, type, payload));
      // ── workspace 族（W1 绑定闭环；handlers/workspace.ts）──
      case "workspace.get":
        return this.deps.workspace === undefined
          ? this.commandError(ws, type, "command.unknown", `未知命令：${type}`)
          : handleWorkspaceGet(this.workspaceContext(ws, type));
      case "workspace.open":
        return this.deps.workspace === undefined
          ? this.commandError(ws, type, "command.unknown", `未知命令：${type}`)
          : handleWorkspaceOpen(this.workspaceContext(ws, type, payload));
      // ── task 族（P-2 任务页九命令族，契约 task-api，§8.1；handlers/task.ts）──
      case "task.list":
        return handleTaskList(this.taskContext(ws, type, payload));
      case "task.detail":
        return handleTaskDetail(this.taskContext(ws, type, payload));
      case "task.artifacts":
        return handleTaskArtifacts(this.taskContext(ws, type, payload));
      case "task.subscribe":
        return handleTaskSubscribe(this.taskContext(ws, type, payload));
      case "task.unsubscribe":
        return handleTaskUnsubscribe(this.taskContext(ws, type, payload));
      case "task.pause":
        return handleTaskPause(this.taskContext(ws, type, payload));
      case "task.resume":
        return handleTaskResume(this.taskContext(ws, type, payload));
      case "task.cancel":
        return handleTaskCancel(this.taskContext(ws, type, payload));
      case "task.delete":
        return handleTaskDelete(this.taskContext(ws, type, payload));
      // ── v0.6 agent.config 族（智能体配置页；全局命令先例 = model.catalog）──
      case "agent.config.list":
        return handleAgentConfigList(this.resourceContext(ws, type, payload));
      case "agent.config.set_enabled":
        return handleAgentConfigSetEnabled(this.resourceContext(ws, type, payload));
      // ── v0.7 web 族（联网状态图标；全局命令先例 = agent.config 族）──
      // v0.9 +web.start（CDP 显式启动通路）
      case "web.status":
        return handleWebStatus(this.webContext(ws, type));
      case "web.stop":
        return handleWebStop(this.webContext(ws, type));
      case "web.start":
        return handleWebStart(this.webContext(ws, type));
      // ── v0.2 model 族（AD-2，契约 C §1；真行为回口。微批：结果帧点对点回执）──
      // case 体机械迁出 handlers/model.ts（语义逐字节等价），此处一行转发（AD-3）
      case "model.set":
        return handleModelSet(this.commandContext(ws, type, payload, envelope));
      case "model.get":
        return handleModelGet(this.commandContext(ws, type, payload, envelope));
      case "model.catalog":
        return handleModelCatalog(this.commandContext(ws, type, payload, envelope));
      case "model.catalog_refresh":
        return handleModelCatalogRefresh(this.commandContext(ws, type, payload, envelope));
      case "model.set_thinking_default":
        return handleModelSetThinkingDefault(this.commandContext(ws, type, payload, envelope));
      case "model.set_default":
        return handleModelSetDefault(this.commandContext(ws, type, payload, envelope));
      case "model.get_default":
        return handleModelGetDefault(this.commandContext(ws, type, payload, envelope));
      // ── config 族（压缩参数配置；全局命令）──
      case "config.get_compaction":
        return handleConfigGetCompaction(this.commandContext(ws, type, payload, envelope));
      case "config.set_compaction":
        return handleConfigSetCompaction(this.commandContext(ws, type, payload, envelope));
      // ── v0.11 thinking 族（thinking 批①，契约 §17.11；handlers/thinking.ts，model.set 同构）──
      case "thinking.set":
        return handleThinkingSet(this.commandContext(ws, type, payload, envelope));
      // ── v0.2 auth 管理族（AD-2，契约 C §1.3；真行为回口 + 结果帧）──
      // case 体机械迁出 handlers/auth.ts（语义逐字节等价），此处一行转发（AD-3）
      case "auth.list":
        return handleAuthList(this.commandContext(ws, type, payload, envelope));
      case "auth.set_key":
        return handleAuthSetKey(this.commandContext(ws, type, payload, envelope));
      case "auth.delete_key":
        return handleAuthDeleteKey(this.commandContext(ws, type, payload, envelope));
      case "auth.verify":
        return handleAuthVerify(this.commandContext(ws, type, payload, envelope));
      default:
        this.commandError(ws, type, "command.unknown", `未知命令：${type}`);
    }
  }

  /**
   * model/auth 族命令处理上下文（AD-3）：handlers/ 模块的依赖面注入——
   * ModelPort + system.getStatus() 缺省回退 + 4 个共享辅助（本连接绑定，
   * 语义 = 本类同名私有方法，机械转发零行为差）。
   */
  private commandContext(
    ws: ServerWebSocket<ConnState>,
    type: string,
    payload: Record<string, unknown>,
    envelope: { sessionId?: unknown },
  ): WsCommandContext {
    return {
      ws,
      type,
      payload,
      envelope,
      model: this.deps.model,
      compactionConfig: this.deps.compactionConfig,
      system: this.deps.system,
      commandError: (cmdType, code, message) => this.commandError(ws, cmdType, code, message),
      modelErrorCode: (err) => this.modelErrorCode(err),
      rawSender: () => this.rawSender(ws),
      sendNow: (sender, frame) => this.sendNow(sender, frame),
    };
  }

  /**
   * chat 族命令处理上下文（AD-1，同 commandContext 模式）：ChatPort
   * + SessionDirectoryPort（草稿建会话链）+ EventStream（建会话订阅）+
   * 快照盖章链回调（sessionStamp/snapshotFrame 留本类，机械转发零行为差）。
   */
  private chatContext(
    ws: ServerWebSocket<ConnState>,
    type: string,
    payload: Record<string, unknown>,
    envelope: { sessionId?: unknown },
  ): ChatCommandContext {
    return {
      ws,
      type,
      payload,
      envelope,
      chat: this.deps.chat,
      directory: this.deps.directory,
      events: this.deps.events,
      sessionStamp: (view) => this.sessionStamp(view),
      snapshotFrame: (view, model, agentState) => this.snapshotFrame(view, model, agentState),
      // W1 绑定闭环：草稿建会话门禁判别面（未装配 workspace 面时缺省视为已绑定）
      ...(this.deps.workspace !== undefined ? { workspaceBound: () => this.deps.workspace!.isBound() } : {}),
      commandError: (cmdType, code, message) => this.commandError(ws, cmdType, code, message),
      sendNow: (sender, frame) => this.sendNow(sender, frame),
    };
  }

  /**
   * session 族命令处理上下文（AD-1）：SessionDirectoryPort（目录/视图/
   * 删除/目标解析）+ EventStream 订阅面 + 快照盖章链回调 + 共享辅助。
   */
  private sessionContext(
    ws: ServerWebSocket<ConnState>,
    type: string,
    payload: Record<string, unknown>,
    envelope: { sessionId?: unknown },
  ): SessionCommandContext {
    return {
      ws,
      type,
      payload,
      envelope,
      directory: this.deps.directory,
      events: this.deps.events,
      sessionStamp: (view) => this.sessionStamp(view),
      snapshotFrame: (view, model, agentState) => this.snapshotFrame(view, model, agentState),
      commandError: (cmdType, code, message) => this.commandError(ws, cmdType, code, message),
      rawSender: () => this.rawSender(ws),
      sendNow: (sender, frame) => this.sendNow(sender, frame),
    };
  }

  /** agent 族命令处理上下文（AD-1）：AgentOrchestrationPort + EventStream 实例订阅。 */
  private agentContext(
    ws: ServerWebSocket<ConnState>,
    type: string,
    payload: Record<string, unknown>,
  ): AgentCommandContext {
    return {
      ws,
      type,
      payload,
      orchestration: this.deps.orchestration,
      events: this.deps.events,
      commandError: (cmdType, code, message) => this.commandError(ws, cmdType, code, message),
    };
  }

  /** trace 族命令处理上下文（AD-1）：trace 读面（未装配 → undefined，handler 回 command.unimplemented）。 */
  private traceContext(
    ws: ServerWebSocket<ConnState>,
    type: string,
    payload: Record<string, unknown>,
  ): TraceCommandContext {
    return {
      ws,
      type,
      payload,
      traceQuery: this.deps.traceQuery,
      commandError: (cmdType, code, message) => this.commandError(ws, cmdType, code, message),
      rawSender: () => this.rawSender(ws),
      sendNow: (sender, frame) => this.sendNow(sender, frame),
    };
  }

  /**
   * kg 族命令处理上下文（§9 六命令族）：KgViewerService 应用编排面
   * （未装配 → undefined，handler 回 command.unimplemented——trace.ts 先例）
   * + 共享辅助（本连接绑定，语义 = 本类同名私有方法，机械转发零行为差）。
   * W1 重绑接缝：生产面 kg 经 workspace 持有者读现值（重绑后自动跟随）；
   * workspaceUnbound = 防御契约判别（空集结果非报错）。
   */
  private kgContext(
    ws: ServerWebSocket<ConnState>,
    type: string,
    payload: Record<string, unknown>,
  ): KgCommandContext {
    return {
      ws,
      type,
      payload,
      kg: this.deps.kg ?? this.deps.workspace?.stack()?.viewerService,
      bootstrap:
        this.deps.kgBootstrap === undefined
          ? undefined
          : typeof this.deps.kgBootstrap === "function"
            ? this.deps.kgBootstrap()
            : this.deps.kgBootstrap,
      maintenance:
        this.deps.kgMaintenance === undefined
          ? undefined
          : typeof this.deps.kgMaintenance === "function"
            ? this.deps.kgMaintenance()
            : this.deps.kgMaintenance,
      review:
        this.deps.kgReview === undefined
          ? undefined
          : typeof this.deps.kgReview === "function"
            ? this.deps.kgReview()
            : this.deps.kgReview,
      workspaceUnbound: this.deps.workspace !== undefined && !this.deps.workspace.isBound(),
      commandError: (cmdType, code, message) => this.commandError(ws, cmdType, code, message),
      rawSender: () => this.rawSender(ws),
      sendNow: (sender, frame) => this.sendNow(sender, frame),
    };
  }

  /**
   * workspace 族命令处理上下文（W1 绑定闭环）：WorkspaceService 绑定
   * 状态机（get 快照/open 写面）+ 共享辅助（本连接绑定，语义 = 本类同名
   * 私有方法，机械转发零行为差）。无 payload 形状消费在 get；open 的
   * payload.root 形状校验在 handler 入口。
   */
  private workspaceContext(
    ws: ServerWebSocket<ConnState>,
    type: string,
    payload: Record<string, unknown> = {},
  ): WorkspaceCommandContext {
    const workspace = this.deps.workspace!;
    return {
      ws,
      type,
      payload,
      workspace,
      commandError: (cmdType, code, message) => this.commandError(ws, cmdType, code, message),
      rawSender: () => this.rawSender(ws),
      sendNow: (sender, frame) => this.sendNow(sender, frame),
    };
  }

  /**
   * agent.config 族命令处理上下文（契约 v0.6）：ResourceConfigPort
   * + 合并目录（model 型 hasModel 前置校验）+ EventStream（changed 广播）
   * + 共享辅助（本连接绑定，语义 = 本类同名私有方法，机械转发零行为差）。
   */
  private resourceContext(
    ws: ServerWebSocket<ConnState>,
    type: string,
    payload: Record<string, unknown>,
  ): ResourceCommandContext {
    return {
      ws,
      type,
      payload,
      resource: this.deps.resource,
      hasModel: this.deps.hasModel,
      kgWriterPinnedTools: this.deps.kgWriterPinnedTools,
      events: this.deps.events,
      commandError: (cmdType, code, message) => this.commandError(ws, cmdType, code, message),
      rawSender: () => this.rawSender(ws),
      sendNow: (sender, frame) => this.sendNow(sender, frame),
    };
  }

  /**
   * task 族命令处理上下文（P-2 九命令族，§8.1）：TaskQueryService 读面 +
   * TaskEnginePort 生命周期写面（未装配 → undefined，handler 回
   * command.unimplemented——kg.ts 先例）+ EventStream（连接级任务订阅表 +
   * task.changed 广播）+ 共享辅助（本连接绑定，语义 = 本类同名私有方法，
   * 机械转发零行为差）。
   */
  private taskContext(
    ws: ServerWebSocket<ConnState>,
    type: string,
    payload: Record<string, unknown>,
  ): TaskCommandContext {
    return {
      ws,
      type,
      payload,
      taskQuery: this.deps.taskQuery,
      taskEngine: this.deps.taskEngine,
      events: this.deps.events,
      commandError: (cmdType, code, message) => this.commandError(ws, cmdType, code, message),
      rawSender: () => this.rawSender(ws),
      sendNow: (sender, frame) => this.sendNow(sender, frame),
    };
  }

  /**
   * web 族命令处理上下文（契约 v0.7）：BrowserPort（状态读面/停止写面）
   * + 共享辅助（本连接绑定，语义 = 本类同名私有方法，机械转发零行为差）。
   * 无 payload 消费（web.status / web.stop 均无参），上下文不携带 payload。
   */
  private webContext(
    ws: ServerWebSocket<ConnState>,
    type: string,
  ): WebCommandContext {
    return {
      ws,
      type,
      browser: this.deps.browser,
      commandError: (cmdType, code, message) => this.commandError(ws, cmdType, code, message),
      rawSender: () => this.rawSender(ws),
      sendNow: (sender, frame) => this.sendNow(sender, frame),
    };
  }

  /**
   * 模型/认证命令错误映射（契约 C §4 语义；专用错误码微批已登记）：
   * ModelNotFoundError → model_not_found；ProviderNotFoundError →
   * provider_not_found；会话不存在 → session.not_found（既有）。
   * catalog/catalog_refresh 通路另用 catalog_unreachable（拉取失败）。
   * 判别改 err.code 码匹配（原 err.name 字符串比对；无 code 旧
   * 对象 → 兑底 command.invalid_payload，与原兑底等价）。
   */
  private modelErrorCode(err: Error): ConnectionErrorEvent["payload"]["code"] {
    const code = (err as { code?: ErrorCode }).code;
    if (code === "session.not_found") return "session.not_found";
    if (code === "model_not_found") return "model_not_found";
    if (code === "provider_not_found") return "provider_not_found";
    return "command.invalid_payload";
  }

  private commandError(
    ws: ServerWebSocket<ConnState>,
    type: string,
    code: ConnectionErrorEvent["payload"]["code"],
    message: string,
  ): void {
    this.sendNow(this.rawSender(ws), {
      v: PROTOCOL_VERSION,
      sessionId: SYSTEM_SESSION_ID, // 会话无关系统事件（notification 通道）
      channel: "notification",
      type: "connection.error",
      payload: { code, message: `${message}（命令 ${type}）` },
    });
  }

  // ── 帧发送 ──────────────────────────────────────────────────

  /** 构造连接的协议帧发送端（readyState 守卫：关闭中的连接静默丢弃）。 */
  private rawSender(ws: ServerWebSocket<ConnState>): FrameSender {
    return (frame: EventEnvelope) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    };
  }

  private sendNow(sender: FrameSender, frame: EventEnvelope): void {
    sender(frame);
  }
}
