/**
 * WsServerAdapter —— WS 驱动侧（architecture.md §3.5；CL-6 / F(6).1–F(6).3）。
 *
 * Bun.serve({ hostname: "127.0.0.1", port, websocket }) 原生实现，零新依赖：
 * - HTTP 面：GET /helix-dev-token（浏览器侧 token 获取通道，loopback Origin
 *   反射，见 PROTOCOL.md §9）+ 前端静态产物（组合根注入 driven StaticServe
 *   的 handler，driving 不 import driven——AG-02③）；
 * - WS 面：hello 握手 token 校验（三分支拒绝：发 error 帧后 close）→
 *   welcome + 立即推 session.snapshot（重连恢复 = 快照+增量，AD-16）→
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
 * 绑定纪律（TP-CL6-1）：仅 127.0.0.1，禁止 0.0.0.0/::——构造期即钉死。
 */
import type { SessionChatPort } from "../../../application/ports/inbound/ChatPort";
import type { SystemPort } from "../../../application/ports/inbound/SystemPort";
import type { AgentOrchestrationPort } from "../../../application/ports/inbound/AgentOrchestrationPort";
import type { SessionDirectoryPort } from "../../../application/ports/inbound/SessionDirectoryPort";
import type { ModelPort } from "../../../application/ports/inbound/ModelPort";
import type {
  AgentStateDto,
  AuthDeleteKeyResultEvent,
  AuthListResultEvent,
  AuthSetKeyResultEvent,
  AuthVerifyResultEvent,
  ConnectionErrorEvent,
  ConnectionWelcomeEvent,
  EventEnvelope,
  FrameVersion,
  ModelCatalogRefreshResultEvent,
  ModelCatalogResultEvent,
  ModelGetDefaultResultEvent,
  ModelGetResultEvent,
  ModelSetDefaultResultEvent,
  SessionListResultEvent,
  SessionLoadHistoryResultEvent,
  SessionSnapshotEvent,
} from "@helix/protocol";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import type { ServerWebSocket } from "bun";
import { EventStream, type FrameSender } from "./EventStream";
import { historyPage, toSnapshotDto } from "./DtoMapper";
import type { SessionStateView } from "../../../application/ports/inbound/SessionPort";
import {
  HISTORY_PAGE_DEFAULT,
  HISTORY_PAGE_MAX,
  TAIL_WINDOW_SIZE,
} from "./DtoMapper";

/** 浏览器侧 token 获取端点路径（vite dev 与 static-serve 生产共用同一机制）。 */
export const DEV_TOKEN_PATH = "/helix-dev-token";

/** loopback 开发 Origin（vite dev 等）匹配：localhost / 127.0.0.1 / [::1] 任意端口。 */
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/** 每连接状态（Bun.serve 泛型，经 server.upgrade 的 data 携带）。 */
interface ConnState {
  authed: boolean;
  /** 认证通过后构造的协议帧发送端（EventStream 注册键）。 */
  sender: FrameSender | null;
}

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

    // 通过：注册事件流（T2.2 定稿：默认订阅「当前订阅会话」= 注册表当前会话，
    // 即最近活跃会话——冷则懒加载）+ welcome + 立即推快照（重连恢复语义）
    ws.data.authed = true;
    const sender = this.rawSender(ws);
    ws.data.sender = sender;
    const status = this.deps.system.getStatus();
    this.deps.events.attach(sender, status.sessionId);

    const agentState = status.agentState as AgentStateDto;
    const model = status.model ?? "";
    const welcome: ConnectionWelcomeEvent = {
      v: PROTOCOL_VERSION,
      sessionId: SYSTEM_SESSION_ID, // 会话无关系统事件（notification 通道，契约 A §3）
      channel: "notification",
      type: "connection.welcome",
      payload: { sessionId: status.sessionId, model, agentState },
    };
    this.sendNow(sender, welcome);
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
      case "chat.send": {
        if (typeof payload.text !== "string") return this.commandError(ws, type, "command.invalid_payload", "payload.text 应为 string");
        // 草稿建会话链（契约 B §1.5 定稿）：信封省略 sessionId + payload.draft
        // → daemon 建新会话（首条消息落库 + created 广播）+ 本连接订阅新会话
        // + 快照（客户端据此切换）；draft 标记与显式 sessionId 同现时以 sessionId 为准。
        const hasSessionRoute =
          typeof envelope.sessionId === "string" && envelope.sessionId !== "";
        if (payload.draft === true && !hasSessionRoute) {
          const sender = ws.data.sender;
          void this.deps.directory
            .startDraftSession(payload.text)
            .then(({ sessionId }) => {
              if (!sender) return;
              this.deps.events.subscribeSession(sender, sessionId);
              return this.deps.directory.getSessionView(sessionId).then((view) => {
                // T5.1：草稿快照盖新会话自身章（竞态窗口关闭：A 后台流式事件
                // 可在 register 后立即把 current 拉回 A，getStatus() 不可用作
                // per-session 帧盖章源）
                const stamp = this.sessionStamp(view);
                this.sendNow(sender, this.snapshotFrame(view, stamp.model, stamp.agentState));
              });
            })
            .catch((err) => {
              console.warn(`[ws] 草稿建会话失败：${(err as Error).message}`);
            });
          return;
        }
        // 既有会话发送：信封 sessionId 路由（缺省当前会话，v0 兼容）
        const sid = typeof envelope.sessionId === "string" && envelope.sessionId !== "" ? envelope.sessionId : undefined;
        void this.deps.chat.sendMessage(payload.text, sid).catch((err) => {
          console.warn(`[ws] chat.send 处理失败：${(err as Error).message}`);
        });
        return;
      }
      case "chat.steer": {
        if (typeof payload.text !== "string") return this.commandError(ws, type, "command.invalid_payload", "payload.text 应为 string");
        const sid = typeof envelope.sessionId === "string" && envelope.sessionId !== "" ? envelope.sessionId : undefined;
        void this.deps.chat.steer(payload.text, sid).catch((err) => {
          console.warn(`[ws] chat.steer 处理失败：${(err as Error).message}`);
        });
        return;
      }
      case "chat.abort": {
        const sid = typeof envelope.sessionId === "string" && envelope.sessionId !== "" ? envelope.sessionId : undefined;
        this.deps.chat.abort(sid);
        return;
      }
      case "session.subscribe": {
        const sender = ws.data.sender;
        if (!sender) return;
        // v0.2（T2.1/T2.2）：per-session 订阅——信封 sessionId 指定目标会话；
        // v0 兼容：不带信封位 = 当前会话（缺省订阅语义不变）
        void this.resolveTargetSession(ws, envelope, type).then((target) => {
          if (target === undefined) return; // 不存在会话：已回 connection.error
          this.deps.events.subscribeSession(sender, target);
          // 重新订阅 = 重推该会话全量快照（快照恢复公式，AD-16）
          // T5.1 热修：agentState/model 取目标会话 runtime（随视图同源组装），
          // 不经 system.getStatus()（全局最近活跃投影——多会话下 current 恒被
          // 后台流式会话锚定，盖目标会话快照即串台）
          void this.deps.directory
            .getSessionView(target)
            .then((view) => {
              const stamp = this.sessionStamp(view);
              this.sendNow(sender, this.snapshotFrame(view, stamp.model, stamp.agentState));
            })
            .catch((err) => console.warn(`[ws] 订阅快照组装失败：${(err as Error).message}`));
        });
        return;
      }
      case "session.unsubscribe": {
        const sender = ws.data.sender;
        // T2.1 定稿：对称 per-session 退订——与 subscribe 同一目标会话解析规则
        void this.resolveTargetSession(ws, envelope, type).then((target) => {
          if (sender && target !== undefined) this.deps.events.unsubscribeSession(sender, target);
        });
        return;
      }
      // ── session 族（T2.2，契约 B §1；全局命令 result 点对点回执） ──
      case "session.list": {
        const sender = ws.data.sender ?? this.rawSender(ws);
        void this.deps.directory
          .listSessions()
          .then((sessions) => {
            const frame: SessionListResultEvent = {
              v: PROTOCOL_VERSION,
              sessionId: SYSTEM_SESSION_ID, // 全局命令结果：会话无关
              channel: "session",
              type: "session.list.result",
              payload: { sessions: sessions.map((s) => ({ ...s })) },
            };
            this.sendNow(sender, frame);
          })
          .catch((err) => console.warn(`[ws] session.list 处理失败：${(err as Error).message}`));
        return;
      }
      case "session.loadHistory": {
        const sender = ws.data.sender ?? this.rawSender(ws);
        if (typeof payload.beforeEntryId !== "string" || payload.beforeEntryId === "") {
          return this.commandError(ws, type, "command.invalid_payload", "payload.beforeEntryId 应为非空 string");
        }
        const rawLimit = payload.limit;
        if (rawLimit !== undefined && (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1)) {
          return this.commandError(ws, type, "command.invalid_payload", "payload.limit 应为正整数");
        }
        const beforeEntryId = payload.beforeEntryId;
        const limit = rawLimit === undefined ? HISTORY_PAGE_DEFAULT : Math.min(rawLimit, HISTORY_PAGE_MAX);
        const target = typeof envelope.sessionId === "string" && envelope.sessionId !== "" ? envelope.sessionId : undefined;
        void (async () => {
          try {
            const sessionId = await this.deps.directory.resolveTarget(target);
            const view = await this.deps.directory.getSessionView(sessionId);
            const page = historyPage(view, beforeEntryId, limit);
            const frame: SessionLoadHistoryResultEvent = {
              v: PROTOCOL_VERSION,
              sessionId, // 目标会话归属
              channel: "session",
              type: "session.loadHistory.result",
              payload: { entries: page.entries, hasMore: page.hasMore, nextCursor: page.nextCursor },
            };
            this.sendNow(sender, frame);
          } catch (err) {
            const code =
              (err as Error).name === "SessionNotFoundError" ? "session.not_found" : "session.invalid_cursor";
            this.commandError(ws, type, code, (err as Error).message);
          }
        })();
        return;
      }
      case "session.delete": {
        const target = typeof envelope.sessionId === "string" && envelope.sessionId !== "" ? envelope.sessionId : undefined;
        if (target === undefined) {
          return this.commandError(ws, type, "command.invalid_payload", "session.delete 信封 sessionId 必填");
        }
        void this.deps.directory
          .deleteSession(target)
          .then(() => {
            // 删除回执 = list_changed{deleted} 广播（契约 B §1.4 ack 形态；
            // 取消/删库失败经 catch 回 error）
          })
          .catch((err) => {
            // 契约 B §1.4：取消失败或删库失败时 error（含 reason）；已知错误
            // 精确回码，其余（库删除失败等）以通用命令错误回执携带原因
            const name = (err as Error).name;
            const code =
              name === "SessionDeleteInProgressError"
                ? "session.delete_in_progress"
                : name === "SessionNotFoundError"
                  ? "session.not_found"
                  : "command.invalid_payload";
            this.commandError(ws, type, code, (err as Error).message);
          });
        return;
      }
      // ── v0.1 编排命令（T2.3，契约 §4；只转发不决策，TP-CL6-3） ──
      case "agent.kill": {
        if (typeof payload.agentId !== "string" || payload.agentId === "") {
          return this.commandError(ws, type, "command.invalid_payload", "payload.agentId 应为非空 string");
        }
        // 错误模型（契约 §4）：目标不存在/已终态 → connection.error 回执（中文说明）；
        // 正常路径回执 agent.killed 事件（经事件流广播，单一终态语义）
        const outcome = this.deps.orchestration.kill(payload.agentId);
        if (!outcome.killed) {
          this.commandError(ws, type, "command.invalid_payload", outcome.error);
        }
        return;
      }
      case "agent.subscribe": {
        const sender = ws.data.sender;
        if (typeof payload.agentId !== "string" || payload.agentId === "") {
          return this.commandError(ws, type, "command.invalid_payload", "payload.agentId 应为非空 string");
        }
        if (sender) this.deps.events.subscribeInstance(sender, payload.agentId); // 通路语义（§8-1，不过滤）
        return;
      }
      case "agent.unsubscribe": {
        const sender = ws.data.sender;
        if (typeof payload.agentId !== "string" || payload.agentId === "") {
          return this.commandError(ws, type, "command.invalid_payload", "payload.agentId 应为非空 string");
        }
        if (sender) this.deps.events.unsubscribeInstance(sender, payload.agentId);
        return;
      }
      // ── v0.2 model 族（T2.3 AD-2，契约 C §1；真行为回口。微批：结果帧点对点回执）──
      case "model.set": {
        // 会话作用域命令：信封 sessionId（per-session）；缺省回退当前会话（v0 兼容读）
        const sid = typeof envelope.sessionId === "string" && envelope.sessionId !== "" ? envelope.sessionId : undefined;
        if (typeof payload.model !== "string" || payload.model.trim() === "") {
          return this.commandError(ws, type, "command.invalid_payload", "payload.model 应为非空 string（\"provider/model-id\"）");
        }
        // ack = model.changed 广播（ModelService 内发；订阅该会话的连接即时收到
        // model/previous/effective——契约 C §1.1「即时 ack + 广播」，微批不动）
        void this.deps.model
          .setModel(sid ?? this.deps.system.getStatus().sessionId, payload.model)
          .catch((err) => this.commandError(ws, type, this.modelErrorCode(err), (err as Error).message));
        return;
      }
      case "model.get": {
        const sender = ws.data.sender ?? this.rawSender(ws);
        const sid = typeof envelope.sessionId === "string" && envelope.sessionId !== "" ? envelope.sessionId : undefined;
        const target = sid ?? this.deps.system.getStatus().sessionId;
        void this.deps.model
          .getModel(target)
          .then((info) => {
            const frame: ModelGetResultEvent = {
              v: PROTOCOL_VERSION,
              sessionId: target, // per-session 命令：目标会话归属（loadHistory.result 同构）
              channel: "model",
              type: "model.get.result",
              payload: { model: info.model, isDefault: info.isDefault, defaultModel: info.defaultModel },
            };
            this.sendNow(sender, frame);
          })
          .catch((err) => this.commandError(ws, type, this.modelErrorCode(err), (err as Error).message));
        return;
      }
      case "model.catalog": {
        const sender = ws.data.sender ?? this.rawSender(ws);
        void this.deps.model
          .catalog()
          .then((snapshot) => {
            const frame: ModelCatalogResultEvent = {
              v: PROTOCOL_VERSION,
              sessionId: SYSTEM_SESSION_ID, // 全局命令：会话无关（session.list.result 同构）
              channel: "model",
              type: "model.catalog.result",
              payload: {
                models: snapshot.models.map((m) => ({ ...m, cost: { ...m.cost } })),
                refreshedAt: snapshot.refreshedAt,
                source: snapshot.source,
              },
            };
            this.sendNow(sender, frame);
          })
          .catch((err) => this.commandError(ws, type, "catalog_unreachable", (err as Error).message));
        return;
      }
      case "model.catalog_refresh": {
        const sender = ws.data.sender ?? this.rawSender(ws);
        void this.deps.model
          .catalogRefresh()
          .then((snapshot) => {
            const frame: ModelCatalogRefreshResultEvent = {
              v: PROTOCOL_VERSION,
              sessionId: SYSTEM_SESSION_ID,
              channel: "model",
              type: "model.catalog_refresh.result",
              payload: {
                models: snapshot.models.map((m) => ({ ...m, cost: { ...m.cost } })),
                refreshedAt: snapshot.refreshedAt,
                source: snapshot.source,
                degraded: [...snapshot.degraded], // 降级说明（单 provider 拉取失败明细）
              },
            };
            this.sendNow(sender, frame);
          })
          .catch((err) => this.commandError(ws, type, "catalog_unreachable", (err as Error).message));
        return;
      }
      case "model.set_default": {
        const sender = ws.data.sender ?? this.rawSender(ws);
        if (typeof payload.model !== "string" || payload.model.trim() === "") {
          return this.commandError(ws, type, "command.invalid_payload", "payload.model 应为非空 string（\"provider/model-id\"）");
        }
        void this.deps.model
          .setDefault(payload.model)
          .then((r) => {
            const frame: ModelSetDefaultResultEvent = {
              v: PROTOCOL_VERSION,
              sessionId: SYSTEM_SESSION_ID,
              channel: "model",
              type: "model.set_default.result",
              payload: { previous: r.previous },
            };
            this.sendNow(sender, frame);
          })
          .catch((err) => this.commandError(ws, type, this.modelErrorCode(err), (err as Error).message));
        return;
      }
      case "model.get_default": {
        const sender = ws.data.sender ?? this.rawSender(ws);
        const r = this.deps.model.getDefault();
        const frame: ModelGetDefaultResultEvent = {
          v: PROTOCOL_VERSION,
          sessionId: SYSTEM_SESSION_ID,
          channel: "model",
          type: "model.get_default.result",
          payload: { model: r.model },
        };
        this.sendNow(sender, frame);
        return;
      }
      // ── v0.2 auth 管理族（T2.3 AD-2，契约 C §1.3；真行为回口 + 结果帧）──
      case "auth.list": {
        const sender = ws.data.sender ?? this.rawSender(ws);
        void this.deps.model
          .authList()
          .then((providers) => {
            const frame: AuthListResultEvent = {
              v: PROTOCOL_VERSION,
              sessionId: SYSTEM_SESSION_ID,
              channel: "model",
              type: "auth.list.result",
              payload: { providers: providers.map((p) => ({ ...p })) },
            };
            this.sendNow(sender, frame);
          })
          .catch((err) => this.commandError(ws, type, this.modelErrorCode(err), (err as Error).message));
        return;
      }
      case "auth.set_key": {
        const sender = ws.data.sender ?? this.rawSender(ws);
        if (typeof payload.providerId !== "string" || payload.providerId === "") {
          return this.commandError(ws, type, "command.invalid_payload", "payload.providerId 应为非空 string");
        }
        if (typeof payload.apiKey !== "string" || payload.apiKey.trim() === "") {
          return this.commandError(ws, type, "command.invalid_payload", "payload.apiKey 应为非空 string（空值 = 协议层 error，契约 C §1.3）");
        }
        void this.deps.model
          .authSetKey(payload.providerId, payload.apiKey)
          .then((r) => {
            const frame: AuthSetKeyResultEvent = {
              v: PROTOCOL_VERSION,
              sessionId: SYSTEM_SESSION_ID,
              channel: "model",
              type: "auth.set_key.result",
              payload: { keyMasked: r.keyMasked },
            };
            this.sendNow(sender, frame);
          })
          .catch((err) => this.commandError(ws, type, this.modelErrorCode(err), (err as Error).message));
        return;
      }
      case "auth.delete_key": {
        const sender = ws.data.sender ?? this.rawSender(ws);
        if (typeof payload.providerId !== "string" || payload.providerId === "") {
          return this.commandError(ws, type, "command.invalid_payload", "payload.providerId 应为非空 string");
        }
        void this.deps.model
          .authDeleteKey(payload.providerId)
          .then(() => {
            const frame: AuthDeleteKeyResultEvent = {
              v: PROTOCOL_VERSION,
              sessionId: SYSTEM_SESSION_ID,
              channel: "model",
              type: "auth.delete_key.result",
              payload: {}, // 契约 C §1.3：响应 `{}`（成功回执即帧本身）
            };
            this.sendNow(sender, frame);
          })
          .catch((err) => this.commandError(ws, type, this.modelErrorCode(err), (err as Error).message));
        return;
      }
      case "auth.verify": {
        const sender = ws.data.sender ?? this.rawSender(ws);
        if (typeof payload.providerId !== "string" || payload.providerId === "") {
          return this.commandError(ws, type, "command.invalid_payload", "payload.providerId 应为非空 string");
        }
        void this.deps.model
          .authVerify(payload.providerId)
          .then((r) => {
            const frame: AuthVerifyResultEvent = {
              v: PROTOCOL_VERSION,
              sessionId: SYSTEM_SESSION_ID,
              channel: "model",
              type: "auth.verify.result",
              payload: r.status === "ok" ? { status: "ok", latencyMs: r.latencyMs } : { status: "fail", reason: r.reason }, // fail 是正常结果非 error
            };
            this.sendNow(sender, frame);
          })
          .catch((err) => this.commandError(ws, type, this.modelErrorCode(err), (err as Error).message));
        return;
      }
      default:
        this.commandError(ws, type, "command.unknown", `未知命令：${type}`);
    }
  }

  /**
   * 会话作用域命令的目标会话解析（session.subscribe/unsubscribe/loadHistory
   * 共用）：信封 sessionId（v0.2 路由位）→ 缺省当前会话（v0/v0.1 兼容）；
   * 不存在（热/冷均无）→ connection.error（session.not_found）。
   * T2.2：冷会话经注册表懒加载后即为合法目标。
   */
  private async resolveTargetSession(
    ws: ServerWebSocket<ConnState>,
    envelope: { sessionId?: unknown },
    type: string,
  ): Promise<string | undefined> {
    const sid =
      typeof envelope.sessionId === "string" && envelope.sessionId !== "" ? envelope.sessionId : undefined;
    try {
      return await this.deps.directory.resolveTarget(sid);
    } catch (err) {
      this.commandError(ws, type, "session.not_found", (err as Error).message);
      return undefined;
    }
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
