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
/** 依赖接口与十一族 context 构造器拆分至 command-contexts.ts（体量治理；机械迁出零行为差）。 */
export type { McpCommandDeps, WsServerAdapterDeps } from "./command-contexts";
import { createCommandContexts, type WsServerAdapterDeps } from "./command-contexts";
import type {
  AgentStateDto,
  ConnectionErrorEvent,
  ConnectionWelcomeEvent,
  EventEnvelope,
  FrameVersion,
  SessionSnapshotEvent,
} from "@helix/protocol";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
// AG-12：ws-server 对 domain 仅 type-only——normalize 校验收口在 driven
// adapter 入口（architecture.md §3.5b「调仓储前」）
import type { ServerWebSocket } from "bun";
import { EventStream, type FrameSender } from "./EventStream";
import { toSnapshotDto, TAIL_WINDOW_SIZE } from "./DtoMapper";
import type { SessionStateView } from "../../../application/ports/inbound/SessionPort";
import type { ConnState } from "./handlers/context";
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
  handleKgCandidatesList,
  handleKgIndexDelete,
  handleKgIndexStatus,
  handleKgList,
  handleKgNodeConfirm,
  handleKgNodeDetail,
  handleKgProjects,
  handleKgReviewCreate,
  handleCodeReviewCreate,
  handleKgNodeSupersede,
  handleKgNodeUpdate,
} from "./handlers/kg";
import { handleAgentBasePromptGet, handleAgentConfigList, handleAgentConfigSetEnabled, handleAgentSkillContentGet, handleAgentSkillCreate } from "./handlers/resource";
import { handleWebStart, handleWebStatus, handleWebStop } from "./handlers/web";
import {
  handleMcpServersAdd,
  handleMcpServersList,
  handleMcpServersRemove,
  handleMcpServersTest,
  handleMcpServersUpdate,
  handleMcpToolsList,
} from "./handlers/mcp";
import {
  handleModelCatalog,
  handleModelCatalogRefresh,
  handleModelGet,
  handleModelGetDefault,
  handleModelSet,
  handleModelSetDefault,
  handleModelSetThinkingDefault,
} from "./handlers/model";
import { handleConfigGetCompaction, handleConfigSetCompaction, handleConfigGetScheduling, handleConfigSetScheduling, handleConfigGetPort, handleConfigSetPort } from "./handlers/config";
import { handleThinkingSet } from "./handlers/thinking";
import { handleWorkspaceGet, handleWorkspaceOpen } from "./handlers/workspace";
import { handleDiffGet } from "./handlers/diff";
import {
  handleTaskArtifacts,
  handleTaskCancel,
  handleTaskDelete,
  handleTaskDetail,
  handleTaskList,
  handleTaskPause,
  handleTaskResume,
  handleTaskRetry,
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

/** JSON 形状守卫后的原始命令帧（onMessage 保证为对象；字段仍 unknown 逐案校验——非协议 CommandEnvelope，校验前的宽松形状）。 */
type RawCommandFrame = { v: FrameVersion | number | string; type: unknown; payload: unknown; sessionId?: unknown };

/** 信任源族：①loopback 开发 Origin（vite dev 等）：localhost / 127.0.0.1 /
 *  [::1] 任意端口；②打包形态应用自有资产协议源：tauri://localhost
 *  （macOS/Linux）与 http(s)://tauri.localhost（Windows）——该协议/主机仅
 *  本应用的 webview 可用（OS 注册专属），信任级不低于 loopback http
 *  （任一本地进程都可 serve loopback http，而 tauri 源只有本应用能开）。
 *  打包前端由此取 token（W6m 实证：缺此两款 → 打包形态永远卡在
 *  「正在连接 daemon…」——token 403，握手无法发起）。 */
const LOOPBACK_ORIGIN_RE =
  /^(?:https?:\/\/(?:localhost|127\.0\.0\.1|\[::1])(?::\d+)?|https?:\/\/tauri\.localhost|tauri:\/\/localhost)$/i;

export class WsServerAdapter {
  private readonly deps: WsServerAdapterDeps;
  /** 十一族命令 context 构造器（依赖面组装在 command-contexts.ts；连接绑定回调经闭包注回）。 */
  private readonly contexts: ReturnType<typeof createCommandContexts>;
  private readonly server: Bun.Server<ConnState>;
  /**
   * 握手进行中的命令帧排队表（F2 握手竞态修复）：hello 通过校验后
   * handleHandshake 有 await 窗口（probeCurrentDraft/getSessionView），窗口内
   * 到达的命令帧不能直接路由——EventStream.attach 尚未执行，subscribeSession
   * 会 connections.get(sender)===undefined 静默落空（订阅永久丢失），且
   * *.result 回执会先于 connection.welcome 到达。排队至握手完成后按序回放。
   */
  private readonly handshakeQueues = new Map<ServerWebSocket<ConnState>, RawCommandFrame[]>();

  constructor(deps: WsServerAdapterDeps) {
    this.deps = deps;
    this.contexts = createCommandContexts(deps, {
      // 连接面回调留守本类（握手/事件流共用），闭包注回 context 构造器
      commandError: (ws, type, code, message) => this.commandError(ws, type, code, message),
      rawSender: (ws) => this.rawSender(ws),
      sendNow: (sender, frame) => this.sendNow(sender, frame),
      sessionStamp: (view) => this.sessionStamp(view),
      snapshotFrame: (view, model, agentState) => this.snapshotFrame(view, model, agentState),
    });
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
    this.handshakeQueues.delete(ws); // 窗口内断连：丢弃排队帧（回放面另有 readyState 守卫）
    if (ws.data.sender) this.deps.events.detach(ws.data.sender);
  }

  private onMessage(ws: ServerWebSocket<ConnState>, data: string | Buffer): void {
    let envelope: unknown;
    try {
      envelope = JSON.parse(String(data));
    } catch {
      ws.close(); // 非 JSON 帧 = 连接层垃圾数据（契约 §7：不发帧直接 close）
      return;
    }
    // JSON 形状守卫（F2）：null/原始值是合法 JSON 但不是命令信封——未认证路径
    // null.type 会在 async handleHandshake 内抛 TypeError 成 unhandled rejection
    // 且连接悬挂；与非 JSON 帧同口径 ws.close()。
    if (typeof envelope !== "object" || envelope === null) {
      ws.close();
      return;
    }
    const frame = envelope as RawCommandFrame;
    const pending = this.handshakeQueues.get(ws);
    if (pending !== undefined) {
      // 握手进行中（await probeCurrentDraft/getSessionView 窗口）：命令帧排队，
      // 握手完成后按序回放。判别位 = 排队表存在性而非 authed——authed/sender
      // 在 await 之前同步置位，窗口内直路由会致 subscribeSession 落空
      //（attach 尚未执行）且 *.result 回执先于 connection.welcome。
      pending.push(frame);
      return;
    }
    if (!ws.data.authed) {
      this.handshakeQueues.set(ws, []);
      void this.handleHandshake(ws, frame).finally(() => {
        const queued = this.handshakeQueues.get(ws) ?? [];
        this.handshakeQueues.delete(ws);
        // 握手拒绝（连接已 close）或窗口内断连：丢弃排队帧不回放
        if (!ws.data.authed || ws.readyState !== WebSocket.OPEN) return;
        for (const queuedFrame of queued) this.routeCommand(ws, queuedFrame);
      });
      return;
    }
    this.routeCommand(ws, frame);
  }

  // ── 握手（三分支） ──────────────────────────────────

  private async handleHandshake(
    ws: ServerWebSocket<ConnState>,
    envelope: RawCommandFrame,
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
    if (view !== undefined) {
      // M4：快照盖章 = 视图同源组装（sessionStamp——model 缺省回退全局
      // 默认，禁 getStatus 全局投影（缺省回退空串与 sessionStamp 口径不一），
      // E-54 纪律唯一例外点收口；与 handlers/chat.ts/session.ts 同构）。
      // welcome 仍取 getStatus（连接级帧回带全局现值，非 per-session 盖章面）。
      const stamp = this.sessionStamp(view);
      this.sendNow(sender, this.snapshotFrame(view, stamp.model, stamp.agentState));
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
    envelope: RawCommandFrame,
  ): void {
    const type = typeof envelope.type === "string" ? envelope.type : "";
    const payload = (envelope.payload ?? {}) as Record<string, unknown>;

    switch (type) {
      // ── chat 族（AD-1：case 体机械迁出 handlers/chat.ts，此处一行转发）──
      case "chat.send":
        return handleChatSend(this.contexts.chatContext(ws, type, payload, envelope));
      case "chat.steer":
        return handleChatSteer(this.contexts.chatContext(ws, type, payload, envelope));
      case "chat.abort":
        return handleChatAbort(this.contexts.chatContext(ws, type, payload, envelope));
      // ── session 族（契约 B §1；AD-1 迁出 handlers/session.ts）──
      case "session.subscribe":
        return handleSessionSubscribe(this.contexts.sessionContext(ws, type, payload, envelope));
      case "session.unsubscribe":
        return handleSessionUnsubscribe(this.contexts.sessionContext(ws, type, payload, envelope));
      case "session.list":
        return handleSessionList(this.contexts.sessionContext(ws, type, payload, envelope));
      case "session.loadHistory":
        return handleSessionLoadHistory(this.contexts.sessionContext(ws, type, payload, envelope));
      case "session.delete":
        return handleSessionDelete(this.contexts.sessionContext(ws, type, payload, envelope));
      // ── v0.1 编排命令（契约 §4；AD-1 迁出 handlers/agent.ts）──
      case "agent.kill":
        return handleAgentKill(this.contexts.agentContext(ws, type, payload));
      case "agent.subscribe":
        return handleAgentSubscribe(this.contexts.agentContext(ws, type, payload));
      case "agent.unsubscribe":
        return handleAgentUnsubscribe(this.contexts.agentContext(ws, type, payload));
      // ── v0.4 trace 族（契约 v0.4 §1；AD-1 迁出 handlers/trace.ts）──
      case "trace.query":
        return handleTraceQuery(this.contexts.traceContext(ws, type, payload));
      // ── kg 族（P-1 六命令族，契约 kg-viewer-api，§9；handlers/kg.ts）──
      case "kg.projects":
        return handleKgProjects(this.contexts.kgContext(ws, type, payload));
      case "kg.list":
        return handleKgList(this.contexts.kgContext(ws, type, payload));
      case "kg.node.detail":
        return handleKgNodeDetail(this.contexts.kgContext(ws, type, payload));
      case "kg.change.report":
        return handleKgChangeReport(this.contexts.kgContext(ws, type, payload));
      case "kg.node.confirm":
        return handleKgNodeConfirm(this.contexts.kgContext(ws, type, payload));
      case "kg.index.status":
        return handleKgIndexStatus(this.contexts.kgContext(ws, type, payload));
      // ── kg-bootstrap 批（T3.2，契约 kg-bootstrap-api；handlers/kg.ts）──
      case "kg.bootstrap.create":
        return handleKgBootstrapCreate(this.contexts.kgContext(ws, type, payload));
      case "kg.bootstrap.produce":
        return handleKgBootstrapProduce(this.contexts.kgContext(ws, type, payload));
      case "kg.node.update":
        return handleKgNodeUpdate(this.contexts.kgContext(ws, type, payload));
      case "kg.node.supersede":
        return handleKgNodeSupersede(this.contexts.kgContext(ws, type, payload));
      case "kg.bootstrap.impact":
        return handleKgBootstrapImpact(this.contexts.kgContext(ws, type, payload));
      // ── kg 维护批（C1，契约 PROTOCOL-CHANGELOG.md §22；handlers/kg.ts）──
      case "kg.graph.purge":
        return handleKgGraphPurge(this.contexts.kgContext(ws, type, payload));
      case "kg.index.delete":
        return handleKgIndexDelete(this.contexts.kgContext(ws, type, payload));
      // ── kg.health 批（W2-E 轨一体检看板；handlers/kg.ts）──
      case "kg.health":
        return handleKgHealth(this.contexts.kgContext(ws, type, payload));
      // ── kg.candidates.list 批（台账读面三件套之三；handlers/kg.ts）──
      case "kg.candidates.list":
        return handleKgCandidatesList(this.contexts.kgContext(ws, type, payload));
      // ── kg 评审批（W2-F 轨二体检任务发起；handlers/kg.ts）──
      case "kg.review.create":
        return handleKgReviewCreate(this.contexts.kgContext(ws, type, payload));
      // ── code-review 批（code-review v1.5 体检区代码评审入口；handlers/kg.ts）──
      case "code.review.create":
        return handleCodeReviewCreate(this.contexts.kgContext(ws, type, payload));
      // ── workspace 族（W1 绑定闭环；handlers/workspace.ts）──
      case "workspace.get":
        return this.deps.workspace === undefined
          ? this.commandError(ws, type, "command.unimplemented", `命令未装配：${type}`)
          : handleWorkspaceGet(this.contexts.workspaceContext(ws, type));
      case "workspace.open":
        return this.deps.workspace === undefined
          ? this.commandError(ws, type, "command.unimplemented", `命令未装配：${type}`)
          : handleWorkspaceOpen(this.contexts.workspaceContext(ws, type, payload));
      // ── task 族（P-2 任务页九命令族，契约 task-api，§8.1；handlers/task.ts）──
      case "task.list":
        return handleTaskList(this.contexts.taskContext(ws, type, payload));
      case "task.detail":
        return handleTaskDetail(this.contexts.taskContext(ws, type, payload));
      case "task.artifacts":
        return handleTaskArtifacts(this.contexts.taskContext(ws, type, payload));
      case "task.subscribe":
        return handleTaskSubscribe(this.contexts.taskContext(ws, type, payload));
      case "task.unsubscribe":
        return handleTaskUnsubscribe(this.contexts.taskContext(ws, type, payload));
      case "task.pause":
        return handleTaskPause(this.contexts.taskContext(ws, type, payload));
      case "task.resume":
        return handleTaskResume(this.contexts.taskContext(ws, type, payload));
      case "task.cancel":
        return handleTaskCancel(this.contexts.taskContext(ws, type, payload));
      case "task.retry":
        return handleTaskRetry(this.contexts.taskContext(ws, type, payload));
      case "task.delete":
        return handleTaskDelete(this.contexts.taskContext(ws, type, payload));
      // ── diff 族（T3+T4 轮次 diff 协议与 UI 闭环；handlers/diff.ts）──
      case "diff.get":
        return handleDiffGet(this.contexts.diffContext(ws, type, payload, envelope));
      // ── v0.6 agent.config 族（智能体配置页；全局命令先例 = model.catalog）──
      case "agent.config.list":
        return handleAgentConfigList(this.contexts.resourceContext(ws, type, payload));
      case "agent.config.set_enabled":
        return handleAgentConfigSetEnabled(this.contexts.resourceContext(ws, type, payload));
      // ── base prompt 批（agent 页 base 段系统提示词懒查询读面；agent.config 同族）──
      case "agent.base_prompt.get":
        return handleAgentBasePromptGet(this.contexts.resourceContext(ws, type, payload));
      // ── skill-content 批（agent 页 skill 正文懒查询读面；base prompt 同族同判据）──
      case "agent.skill_content.get":
        return handleAgentSkillContentGet(this.contexts.resourceContext(ws, type, payload));
      // ── skills 添加批（settings skills 分区创建写面；两渠道统一全文入参）──
      case "agent.skill.create":
        return handleAgentSkillCreate(this.contexts.resourceContext(ws, type, payload));
      // ── v0.7 web 族（联网状态图标；全局命令先例 = agent.config 族）──
      // v0.9 +web.start（CDP 显式启动通路）
      case "web.status":
        return handleWebStatus(this.contexts.webContext(ws, type));
      case "web.stop":
        return handleWebStop(this.contexts.webContext(ws, type));
      case "web.start":
        return handleWebStart(this.contexts.webContext(ws, type));
      // ── mcp 批（MCP server 标准接入六命令；全局命令先例 = web 族）──
      case "mcp.servers.list":
        return this.deps.mcp === undefined
          ? this.commandError(ws, type, "command.unimplemented", `命令未装配：${type}`)
          : handleMcpServersList(this.contexts.mcpContext(ws, type, payload));
      case "mcp.servers.add":
        return this.deps.mcp === undefined
          ? this.commandError(ws, type, "command.unimplemented", `命令未装配：${type}`)
          : handleMcpServersAdd(this.contexts.mcpContext(ws, type, payload));
      case "mcp.servers.update":
        return this.deps.mcp === undefined
          ? this.commandError(ws, type, "command.unimplemented", `命令未装配：${type}`)
          : handleMcpServersUpdate(this.contexts.mcpContext(ws, type, payload));
      case "mcp.servers.remove":
        return this.deps.mcp === undefined
          ? this.commandError(ws, type, "command.unimplemented", `命令未装配：${type}`)
          : handleMcpServersRemove(this.contexts.mcpContext(ws, type, payload));
      case "mcp.servers.test":
        return this.deps.mcp === undefined
          ? this.commandError(ws, type, "command.unimplemented", `命令未装配：${type}`)
          : handleMcpServersTest(this.contexts.mcpContext(ws, type, payload));
      case "mcp.tools.list":
        return this.deps.mcp === undefined
          ? this.commandError(ws, type, "command.unimplemented", `命令未装配：${type}`)
          : handleMcpToolsList(this.contexts.mcpContext(ws, type, payload));
      // ── v0.2 model 族（AD-2，契约 C §1；真行为回口。微批：结果帧点对点回执）──
      // case 体机械迁出 handlers/model.ts（语义逐字节等价），此处一行转发（AD-3）
      case "model.set":
        return handleModelSet(this.contexts.commandContext(ws, type, payload, envelope));
      case "model.get":
        return handleModelGet(this.contexts.commandContext(ws, type, payload, envelope));
      case "model.catalog":
        return handleModelCatalog(this.contexts.commandContext(ws, type, payload, envelope));
      case "model.catalog_refresh":
        return handleModelCatalogRefresh(this.contexts.commandContext(ws, type, payload, envelope));
      case "model.set_thinking_default":
        return handleModelSetThinkingDefault(this.contexts.commandContext(ws, type, payload, envelope));
      case "model.set_default":
        return handleModelSetDefault(this.contexts.commandContext(ws, type, payload, envelope));
      case "model.get_default":
        return handleModelGetDefault(this.contexts.commandContext(ws, type, payload, envelope));
      // ── config 族（压缩参数/调度预算/WS 端口配置；全局命令）──
      case "config.get_compaction":
        return handleConfigGetCompaction(this.contexts.commandContext(ws, type, payload, envelope));
      case "config.set_compaction":
        return handleConfigSetCompaction(this.contexts.commandContext(ws, type, payload, envelope));
      case "config.get_scheduling":
        return handleConfigGetScheduling(this.contexts.commandContext(ws, type, payload, envelope));
      case "config.set_scheduling":
        return handleConfigSetScheduling(this.contexts.commandContext(ws, type, payload, envelope));
      case "config.get_port":
        return handleConfigGetPort(this.contexts.commandContext(ws, type, payload, envelope));
      case "config.set_port":
        return handleConfigSetPort(this.contexts.commandContext(ws, type, payload, envelope));
      // ── v0.11 thinking 族（thinking 批①，契约 §17.11；handlers/thinking.ts，model.set 同构）──
      case "thinking.set":
        return handleThinkingSet(this.contexts.commandContext(ws, type, payload, envelope));
      // ── v0.2 auth 管理族（AD-2，契约 C §1.3；真行为回口 + 结果帧）──
      // case 体机械迁出 handlers/auth.ts（语义逐字节等价），此处一行转发（AD-3）
      case "auth.list":
        return handleAuthList(this.contexts.commandContext(ws, type, payload, envelope));
      case "auth.set_key":
        return handleAuthSetKey(this.contexts.commandContext(ws, type, payload, envelope));
      case "auth.delete_key":
        return handleAuthDeleteKey(this.contexts.commandContext(ws, type, payload, envelope));
      case "auth.verify":
        return handleAuthVerify(this.contexts.commandContext(ws, type, payload, envelope));
      default:
        this.commandError(ws, type, "command.unknown", `未知命令：${type}`);
    }
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
