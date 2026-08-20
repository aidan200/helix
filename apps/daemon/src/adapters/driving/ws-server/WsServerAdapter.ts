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
 * 缺省回退 + 4 个共享辅助）；sessionStamp/snapshotFrame 盖章链与其余族不动。
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
  ConnectionErrorEvent,
  ConnectionWelcomeEvent,
  EventEnvelope,
  FrameVersion,
  SessionListResultEvent,
  SessionLoadHistoryResultEvent,
  SessionSnapshotEvent,
  TraceInstanceRecord,
  TraceQueryResultEvent,
} from "@helix/protocol";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import type { TraceQueryPort } from "../../../domain/trace/TraceQueryPort";
// AG-12：ws-server 对 domain 仅 type-only——normalize 校验收口在 driven
// adapter 入口（architecture.md §3.5b「调仓储前」；AF-9 记录在案）
import type { TraceInstanceRecord as DomainInstanceRecord } from "../../../domain/trace/TraceQuery";
import type { ServerWebSocket } from "bun";
import { EventStream, type FrameSender } from "./EventStream";
import { historyPage, toSnapshotDto } from "./DtoMapper";
import type { SessionStateView } from "../../../application/ports/inbound/SessionPort";
import {
  HISTORY_PAGE_DEFAULT,
  HISTORY_PAGE_MAX,
  TAIL_WINDOW_SIZE,
} from "./DtoMapper";
import type { ConnState, WsCommandContext } from "./handlers/context";
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
      case "chat.send": {
        if (typeof payload.text !== "string") return this.commandError(ws, type, "command.invalid_payload", "payload.text 应为 string");
        // 草稿建会话链（契约 B §1.5 定稿 + T4 转正复用）：信封省略 sessionId
        // + payload.draft → daemon 建会话（零条目当前草稿直接转正复用同 id，
        // 否则新建；首条消息落库 + created 广播）+ 本连接订阅该会话 + 快照
        //（客户端据此切换）；draft 标记与显式 sessionId 同现时以 sessionId 为准。
        const hasSessionRoute =
          typeof envelope.sessionId === "string" && envelope.sessionId !== "";
        if (payload.draft === true && !hasSessionRoute) {
          const sender = ws.data.sender;
          // T4：payload.model 可选透传（建会话前用户选定模型；缺省 = 全局默认）
          const draftModel =
            typeof payload.model === "string" && payload.model !== "" ? payload.model : undefined;
          void this.deps.directory
            .startDraftSession(payload.text, draftModel)
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
        // T2.3（契约 v0.3 §3.2）：instanceId 只透传（路由判定归 ChatService，TR-AD-9）。
        // 回执裁决（T2.3，TR-AD-21）：定向目标非运行中 → ChatService 抛
        // SteerTargetNotRunningError → connection.error 点对点回执（同 agent.kill
        // 形态，复用 SendOutcome.detail 文案）；其余异常维持既有 console.warn。
        const instanceId =
          typeof payload.instanceId === "string" && payload.instanceId !== "" ? payload.instanceId : undefined;
        void this.deps.chat.steer(payload.text, sid, instanceId).catch((err) => {
          if ((err as Error).name === "SteerTargetNotRunningError") {
            this.commandError(ws, type, "command.invalid_payload", (err as Error).message);
            return;
          }
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
        // v0.3（T2.2，契约 §2.1）：payload.tier 可选档位——缺省 full（既有语义
        // 不变，TR-AD-23① 可选参数带缺省语义）；目录外值回 invalid_payload
        const tierRaw = payload.tier;
        if (tierRaw !== undefined && tierRaw !== "full" && tierRaw !== "monitor") {
          return this.commandError(ws, type, "command.invalid_payload", 'payload.tier 应为 "full" | "monitor"');
        }
        const tier: "full" | "monitor" = tierRaw === "monitor" ? "monitor" : "full";
        // v0.2（T2.1/T2.2）：per-session 订阅——信封 sessionId 指定目标会话；
        // v0 兼容：不带信封位 = 当前会话（缺省订阅语义不变）
        void this.resolveTargetSession(ws, envelope, type).then((target) => {
          if (target === undefined) return; // 不存在会话：已回 connection.error
          this.deps.events.subscribeSession(sender, target, tier);
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
      // ── v0.4 trace 族（T2.1，契约 v0.4 §1；session 族先例 inline：校验→normalize→port→组帧→点对点） ──
      case "trace.query": {
        const sender = ws.data.sender ?? this.rawSender(ws);
        if (this.deps.traceQuery === undefined) {
          return this.commandError(ws, type, "command.unimplemented", "trace 读面未装配");
        }
        // normalize 校验收口在 adapter 入口（§3.5b「调仓储前」；本层对 domain
        // 仅 type-only，AG-12）；校验失败 DomainError → 既有错误回帧模式。
        // 目标会话在 payload.sessionId（信封位不消费——直查 domain_events，冷会话可查）
        try {
          const result = this.deps.traceQuery.queryTrace(payload);
          const filter = result.filter;
          const frame: TraceQueryResultEvent = {
            v: PROTOCOL_VERSION,
            sessionId: filter.sessionId, // 目标会话归属
            channel: "trace",
            type: "trace.query.result",
            payload: {
              // filterEcho：实际生效过滤条件回显（AF-5；readonly → 帧侧可变拷贝）
              filterEcho: {
                sessionId: filter.sessionId,
                instanceIds: filter.instanceIds === null ? null : [...filter.instanceIds],
                agentKind: filter.agentKind,
                types: filter.types === null ? null : [...filter.types],
                timeRange: filter.timeRange === null ? null : { ...filter.timeRange },
                page: { ...filter.page },
              },
              instances: result.instances.map(traceInstanceRecordToDto),
              events: result.rows.map((row) => ({ ...row })),
              page: { loaded: result.rows.length, total: result.total, hasMore: result.hasMore },
            },
          };
          this.sendNow(sender, frame); // 点对点（TR-AD-21，不经广播）
        } catch (err) {
          this.commandError(ws, type, "command.invalid_payload", (err as Error).message);
        }
        return;
      }
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

/** domain 实例面板记录 → 协议 DTO（readonly 数组/对象转可变帧形态；逐字段直拷）。 */
function traceInstanceRecordToDto(record: DomainInstanceRecord): TraceInstanceRecord {
  return {
    instanceId: record.instanceId,
    agentKind: record.agentKind,
    profileKind: record.profileKind,
    ...(record.model !== undefined ? { model: record.model } : {}),
    status: record.status,
    ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
    ...(record.task !== undefined ? { task: record.task } : {}),
    eventCount: record.eventCount,
    ...(record.snapshot !== undefined
      ? {
          snapshot: {
            systemPrompt: record.snapshot.systemPrompt,
            tools: [...record.snapshot.tools],
            model: record.snapshot.model,
            ...(record.snapshot.compaction !== undefined
              ? { compaction: { ...record.snapshot.compaction } }
              : {}),
            ...(record.snapshot.hooks !== undefined ? { hooks: [...record.snapshot.hooks] } : {}),
          },
        }
      : {}),
    snapshotMissing: record.snapshotMissing,
    ...(record.modelTimeline !== undefined
      ? { modelTimeline: record.modelTimeline.map((c) => ({ ...c })) }
      : {}),
    ...(record.currentModel !== undefined ? { currentModel: record.currentModel } : {}),
  };
}
