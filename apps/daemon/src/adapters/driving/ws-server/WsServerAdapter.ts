/**
 * WsServerAdapter —— WS 驱动侧（architecture.md §3.5；CL-6 / F(6).1–F(6).3）。
 *
 * Bun.serve({ hostname: "127.0.0.1", port, websocket }) 原生实现，零新依赖：
 * - HTTP 面：GET /helix-dev-token（浏览器侧 token 获取通道，loopback Origin
 *   反射，见 PROTOCOL.md §9）+ 前端静态产物（组合根注入 driven StaticServe
 *   的 handler，driving 不 import driven——AG-02③）；
 * - WS 面：hello 握手 token 校验（三分支拒绝：发 error 帧后 close）→
 *   welcome + 立即推 session.snapshot（重连恢复 = 快照+增量，AD-16；
 *   T4：当前会话命中零条目内存草稿 → welcome.draft + 不 attach 不推快照）→
 *   命令帧路由到 inbound port（只转发不决策，AG-12/TP-CL6-3）→
 *   事件经 EventStream（EventPublisherPort 实现）下发。
 *
 * T2.2（AD-4 多会话）：会话作用域命令按信封 sessionId 路由（缺省 = 当前
 * 会话，v0/v0.1 兼容）经 SessionDirectoryPort/SessionChatPort 解析目标会话；
 * session 族命令（list/loadHistory/delete）+ 草稿建会话链（chat.send 信封
 * 省略 sessionId + payload.draft=true，契约 B §1.5）在此落地；握手 welcome
 * 快照升级为「当前订阅会话」（当前会话 = 注册表最近活跃会话）。
 *
 * T2.3-result-frames 微批：model/auth 9 命令结果改点对点 *.result 结果帧
 * sendNow 直发（契约 C §2.2，与 session 族结果帧同构；model.set 的 ack
 * 仍为 model.changed 广播不动）；错误分支启用专用错误码（契约 C §4）。
 *
 * T1.1（AD-3 handler 模块化）：model 族 6 case + auth 族 4 case 的 case 体
 * 机械迁出 handlers/{model,auth}.ts（语义逐字节等价）；routeCommand 对应
 * case 一行转发（commandContext 供出依赖面：ModelPort + system.getStatus()
 * 缺省回退 + 4 个共享辅助）。
 *
 * T3.2（F(3).4 handler 化收口 + F-8 解环）：其余 12 case（chat/session/
 * agent/trace 族）case 体机械迁出 handlers/{chat,session,agent,trace}.ts
 * （语义逐字节等价；traceInstanceRecordToDto / resolveTargetSession 随族
 * 迁出）；routeCommand 全 22 case 一行转发；族上下文类型承 handlers/
 * context.ts（ConnState/WsCommandContext 上收，F-8 三模块环解）；
 * sessionStamp/snapshotFrame 盖章链留本类，session/chat handler 经上下文
 * 回调机械引用零行为差（不为省行数造成第二份）。
 *
 * 绑定纪律（TP-CL6-1）：仅 127.0.0.1，禁止 0.0.0.0/::——构造期即钉死。
 */
import type { SessionChatPort } from "../../../application/ports/inbound/ChatPort";
import type { SystemPort } from "../../../application/ports/inbound/SystemPort";
import type { AgentOrchestrationPort } from "../../../application/ports/inbound/AgentOrchestrationPort";
import type { SessionDirectoryPort } from "../../../application/ports/inbound/SessionDirectoryPort";
import type { ModelPort } from "../../../application/ports/inbound/ModelPort";
import type { ResourceConfigPort } from "../../../application/ports/inbound/ResourceConfigPort";
import type { BrowserPort } from "../../../application/ports/outbound/BrowserPort";
import type {
  AgentStateDto,
  ConnectionErrorEvent,
  ConnectionWelcomeEvent,
  EventEnvelope,
  FrameVersion,
  SessionSnapshotEvent,
} from "@helix/protocol";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import type { TraceQueryPort } from "../../../domain/trace/TraceQueryPort";
// AG-12：ws-server 对 domain 仅 type-only——normalize 校验收口在 driven
// adapter 入口（architecture.md §3.5b「调仓储前」；AF-9 记录在案）
import type { ServerWebSocket } from "bun";
import { EventStream, type FrameSender } from "./EventStream";
import { toSnapshotDto, TAIL_WINDOW_SIZE } from "./DtoMapper";
import type { SessionStateView } from "../../../application/ports/inbound/SessionPort";
import type {
  AgentCommandContext,
  ChatCommandContext,
  ConnState,
  ResourceCommandContext,
  SessionCommandContext,
  TraceCommandContext,
  WebCommandContext,
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
import { handleAgentConfigList, handleAgentConfigSetEnabled } from "./handlers/resource";
import { handleWebStatus, handleWebStop } from "./handlers/web";
import {
  handleModelCatalog,
  handleModelCatalogRefresh,
  handleModelGet,
  handleModelGetDefault,
  handleModelSet,
  handleModelSetDefault,
} from "./handlers/model";
import {
  handleAuthDeleteKey,
  handleAuthList,
  handleAuthSetKey,
  handleAuthVerify,
} from "./handlers/auth";

/** 浏览器侧 token 获取端点路径（vite dev 与 static-serve 生产共用同一机制）。 */
export const DEV_TOKEN_PATH = "/helix-dev-token";

/** loopback 开发 Origin（vite dev 等）匹配：localhost / 127.0.0.1 / [::1] 任意端口。 */
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export interface WsServerAdapterDeps {
  /** 会话路由对话入口（T2.2：组合根 ChatRouter——按信封 sessionId 分发）。 */
  readonly chat: SessionChatPort;
  /** 会话目录（T2.2 AD-4：list/loadHistory/delete/草稿/目标解析）。 */
  readonly directory: SessionDirectoryPort;
  readonly system: SystemPort;
  /** 编排入口（T2.3）：agent.kill 终止链回 SchedulerService（只转发不决策）。 */
  readonly orchestration: AgentOrchestrationPort;
  /**
   * 模型/认证管理入口（T2.3 AD-2）：model 族与 auth 族命令回口（只转发
   * 不决策）。除 model.set（ack = model.changed 广播）外，9 命令结果经
   * *.result 结果帧点对点回执（T2.3-result-frames 微批，契约 C §2.2）。
   */
  readonly model: ModelPort;
  /**
   * 资源配置面（M6 T3，契约 v0.6）：agent.config 命令族回口（profile kind 维
   * tool/skill 启停 + model 槽位；只转发不决策，AG-12）。
   */
  readonly resource: ResourceConfigPort;
  /**
   * 浏览器连接面（T4，契约 v0.7）：web 族命令回口（web.status 状态读面 /
   * web.stop 停止写面；只转发不决策，AG-12）。状态变更广播不走本面——
   * 组合根 onStatusChange 接线直发 EventStream。
   */
  readonly browser: BrowserPort;
  /**
   * 合并目录校验面（M6 T3）：agent.config model 型 set 前置校验（窄函数
   * 注入 = catalog.hasModel，ModelService.setModel 先例）。
   */
  readonly hasModel: (modelId: string) => boolean;
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
   * trace 读面（T2.1，CL-5/F5.6，契约 v0.4 §1）：trace.query 命令回口
   * （只读 domain_events，连接私有读面）；未装配 → command.unimplemented 回执。
   */
  readonly traceQuery?: TraceQueryPort;
}

export class WsServerAdapter {
  private readonly deps: WsServerAdapterDeps;
  private readonly server: Bun.Server<ConnState>;

  constructor(deps: WsServerAdapterDeps) {
    this.deps = deps;
    this.server = Bun.serve<ConnState>({
      hostname: "127.0.0.1", // TP-CL6-1：仅回环监听（结构保证非 loopback 不可达）
      port: deps.port,
      fetch: (req, srv) => this.onFetch(req, srv),
      websocket: {
        open: (ws) => this.onOpen(ws),
        message: (ws, data) => this.onMessage(ws, data),
        close: (ws) => this.onClose(ws),
      },
    });
  }

  /** 实际监听地址（测试断言源，TP-CL6-1）。 */
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

  // ── 握手（TP-CL6-5 三分支） ──────────────────────────────────

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

    // 通过：注册事件流 + welcome（T4：命中零条目内存草稿 → welcome.draft +
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
      // T2.2 定稿：默认订阅「当前订阅会话」= 注册表当前会话（冷则懒加载）
      this.deps.events.attach(sender, status.sessionId);
    }

    const agentState = status.agentState as AgentStateDto;
    const model = status.model ?? "";
    const welcome: ConnectionWelcomeEvent = {
      v: PROTOCOL_VERSION,
      sessionId: SYSTEM_SESSION_ID, // 会话无关系统事件（notification 通道，契约 A §3）
      channel: "notification",
      type: "connection.welcome",
      payload: { sessionId: status.sessionId, model, agentState, ...(isDraft ? { draft: true } : {}) },
    };
    this.sendNow(sender, welcome);
    if (isDraft) return; // T4：草稿握手不推快照（前端按草稿态显示；建会话链另推）
    try {
      const view = await this.deps.directory.getSessionView(status.sessionId);
      this.sendNow(sender, this.snapshotFrame(view, model, agentState));
    } catch (err) {
      // 快照组装失败不发垃圾帧（连接保持，客户端可 session.list 自取）
      console.warn(`[ws] 握手快照组装失败（会话 ${status.sessionId}）：${(err as Error).message}`);
    }
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
   * per-session 快照盖章（T5.1 热修）：agentState/model 取视图归属会话自身
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

  // ── 命令路由（只转发不决策，TP-CL6-3） ───────────────────────

  private routeCommand(
    ws: ServerWebSocket<ConnState>,
    envelope: { v: FrameVersion | number | string; type: unknown; payload: unknown; sessionId?: unknown },
  ): void {
    const type = typeof envelope.type === "string" ? envelope.type : "";
    const payload = (envelope.payload ?? {}) as Record<string, unknown>;

    switch (type) {
      // ── chat 族（T3.2 AD-1：case 体机械迁出 handlers/chat.ts，此处一行转发）──
      case "chat.send":
        return handleChatSend(this.chatContext(ws, type, payload, envelope));
      case "chat.steer":
        return handleChatSteer(this.chatContext(ws, type, payload, envelope));
      case "chat.abort":
        return handleChatAbort(this.chatContext(ws, type, payload, envelope));
      // ── session 族（T2.2，契约 B §1；T3.2 AD-1 迁出 handlers/session.ts）──
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
      // ── v0.1 编排命令（T2.3，契约 §4；T3.2 AD-1 迁出 handlers/agent.ts）──
      case "agent.kill":
        return handleAgentKill(this.agentContext(ws, type, payload));
      case "agent.subscribe":
        return handleAgentSubscribe(this.agentContext(ws, type, payload));
      case "agent.unsubscribe":
        return handleAgentUnsubscribe(this.agentContext(ws, type, payload));
      // ── v0.4 trace 族（T2.1，契约 v0.4 §1；T3.2 AD-1 迁出 handlers/trace.ts）──
      case "trace.query":
        return handleTraceQuery(this.traceContext(ws, type, payload));
      // ── v0.6 agent.config 族（M6 T3，智能体配置页；全局命令先例 = model.catalog）──
      case "agent.config.list":
        return handleAgentConfigList(this.resourceContext(ws, type, payload));
      case "agent.config.set_enabled":
        return handleAgentConfigSetEnabled(this.resourceContext(ws, type, payload));
      // ── v0.7 web 族（T4 联网状态图标；全局命令先例 = agent.config 族）──
      case "web.status":
        return handleWebStatus(this.webContext(ws, type));
      case "web.stop":
        return handleWebStop(this.webContext(ws, type));
      // ── v0.2 model 族（T2.3 AD-2，契约 C §1；真行为回口。微批：结果帧点对点回执）──
      // T1.1（AD-3）：case 体机械迁出 handlers/model.ts（语义逐字节等价），此处一行转发
      case "model.set":
        return handleModelSet(this.commandContext(ws, type, payload, envelope));
      case "model.get":
        return handleModelGet(this.commandContext(ws, type, payload, envelope));
      case "model.catalog":
        return handleModelCatalog(this.commandContext(ws, type, payload, envelope));
      case "model.catalog_refresh":
        return handleModelCatalogRefresh(this.commandContext(ws, type, payload, envelope));
      case "model.set_default":
        return handleModelSetDefault(this.commandContext(ws, type, payload, envelope));
      case "model.get_default":
        return handleModelGetDefault(this.commandContext(ws, type, payload, envelope));
      // ── v0.2 auth 管理族（T2.3 AD-2，契约 C §1.3；真行为回口 + 结果帧）──
      // T1.1（AD-3）：case 体机械迁出 handlers/auth.ts（语义逐字节等价），此处一行转发
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
   * model/auth 族命令处理上下文（T1.1 AD-3）：handlers/ 模块的依赖面注入——
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
      system: this.deps.system,
      commandError: (cmdType, code, message) => this.commandError(ws, cmdType, code, message),
      modelErrorCode: (err) => this.modelErrorCode(err),
      rawSender: () => this.rawSender(ws),
      sendNow: (sender, frame) => this.sendNow(sender, frame),
    };
  }

  /**
   * chat 族命令处理上下文（T3.2 AD-1，同 commandContext 模式）：ChatPort
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
      commandError: (cmdType, code, message) => this.commandError(ws, cmdType, code, message),
      sendNow: (sender, frame) => this.sendNow(sender, frame),
    };
  }

  /**
   * session 族命令处理上下文（T3.2 AD-1）：SessionDirectoryPort（目录/视图/
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

  /** agent 族命令处理上下文（T3.2 AD-1）：AgentOrchestrationPort + EventStream 实例订阅。 */
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

  /** trace 族命令处理上下文（T3.2 AD-1）：trace 读面（未装配 → undefined，handler 回 command.unimplemented）。 */
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
   * agent.config 族命令处理上下文（M6 T3，契约 v0.6）：ResourceConfigPort
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
      events: this.deps.events,
      commandError: (cmdType, code, message) => this.commandError(ws, cmdType, code, message),
      rawSender: () => this.rawSender(ws),
      sendNow: (sender, frame) => this.sendNow(sender, frame),
    };
  }

  /**
   * web 族命令处理上下文（T4，契约 v0.7）：BrowserPort（状态读面/停止写面）
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
   */
  private modelErrorCode(err: Error): ConnectionErrorEvent["payload"]["code"] {
    const name = (err as Error).name;
    if (name === "SessionNotFoundError") return "session.not_found";
    if (name === "ModelNotFoundError") return "model_not_found";
    if (name === "ProviderNotFoundError") return "provider_not_found";
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
