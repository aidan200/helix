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
 * 绑定纪律（TP-CL6-1）：仅 127.0.0.1，禁止 0.0.0.0/::——构造期即钉死。
 */
import type { ChatPort } from "../../../application/ports/inbound/ChatPort";
import type { SessionPort } from "../../../application/ports/inbound/SessionPort";
import type { SystemPort } from "../../../application/ports/inbound/SystemPort";
import type { AgentOrchestrationPort } from "../../../application/ports/inbound/AgentOrchestrationPort";
import type { AgentStateDto, ConnectionErrorEvent, EventEnvelope, FrameVersion } from "@helix/protocol";
import { PROTOCOL_VERSION } from "@helix/protocol";
import type { ServerWebSocket } from "bun";
import { EventStream, type FrameSender } from "./EventStream";
import { toSnapshotDto } from "./DtoMapper";

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
  readonly chat: ChatPort;
  readonly session: SessionPort;
  readonly system: SystemPort;
  /** 编排入口（T2.3）：agent.kill 终止链回 SchedulerService（只转发不决策）。 */
  readonly orchestration: AgentOrchestrationPort;
  /** 事件流（组合根构造并装配进 fan-out 的 EventPublisherPort 实现）。 */
  readonly events: EventStream;
  /** 本次启动生成的 dev token（与 <home>/dev-token 文件内容一致）。 */
  readonly token: string;
  /** 监听端口（0 = 随机；实际端口经 .port 可发现）。 */
  readonly port: number;
  /** 静态产物 handler（组合根注入 driven StaticServe；未配置时缺省）。 */
  readonly staticHandler?: (req: Request) => Promise<Response | null> | Response | null;
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
    let envelope: { v: FrameVersion | number | string; type: unknown; payload: unknown };
    try {
      envelope = JSON.parse(String(data));
    } catch {
      ws.close(); // 非 JSON 帧 = 连接层垃圾数据（契约 §7：不发帧直接 close）
      return;
    }
    if (!ws.data.authed) {
      this.handleHandshake(ws, envelope);
      return;
    }
    this.routeCommand(ws, envelope);
  }

  // ── 握手（TP-CL6-5 三分支） ──────────────────────────────────

  private handleHandshake(
    ws: ServerWebSocket<ConnState>,
    envelope: { v: FrameVersion | number | string; type: unknown; payload: unknown },
  ): void {
    const reject = (code: ConnectionErrorEvent["payload"]["code"], message: string): void => {
      this.sendNow(this.rawSender(ws), {
        v: PROTOCOL_VERSION,
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

    // 通过：注册事件流 + welcome + 立即推快照（重连恢复语义）
    ws.data.authed = true;
    const sender = this.rawSender(ws);
    ws.data.sender = sender;
    this.deps.events.attach(sender);

    const status = this.deps.system.getStatus();
    const agentState = status.agentState as AgentStateDto;
    const model = status.model ?? "";
    this.sendNow(sender, {
      v: PROTOCOL_VERSION,
      type: "connection.welcome",
      payload: { sessionId: status.sessionId, model, agentState },
    });
    this.sendNow(sender, {
      v: PROTOCOL_VERSION,
      type: "session.snapshot",
      payload: { snapshot: toSnapshotDto(this.deps.session.getSnapshot(), model, agentState) },
    });
  }

  // ── 命令路由（只转发不决策，TP-CL6-3） ───────────────────────

  private routeCommand(
    ws: ServerWebSocket<ConnState>,
    envelope: { v: FrameVersion | number | string; type: unknown; payload: unknown },
  ): void {
    const type = typeof envelope.type === "string" ? envelope.type : "";
    const payload = (envelope.payload ?? {}) as Record<string, unknown>;

    switch (type) {
      case "chat.send": {
        if (typeof payload.text !== "string") return this.commandError(ws, type, "command.invalid_payload", "payload.text 应为 string");
        // 空文本等业务拒绝属 service 规则；adapter 原样转发（结果经事件流可观测）
        void this.deps.chat.sendMessage(payload.text).catch((err) => {
          console.warn(`[ws] chat.send 处理失败：${(err as Error).message}`);
        });
        return;
      }
      case "chat.steer": {
        if (typeof payload.text !== "string") return this.commandError(ws, type, "command.invalid_payload", "payload.text 应为 string");
        void this.deps.chat.steer(payload.text).catch((err) => {
          console.warn(`[ws] chat.steer 处理失败：${(err as Error).message}`);
        });
        return;
      }
      case "chat.abort":
        this.deps.chat.abort();
        return;
      case "session.subscribe": {
        const sender = ws.data.sender;
        if (!sender) return;
        this.deps.events.setSubscribed(sender, true);
        // 通路语义：重新订阅 = 重推全量快照（快照恢复公式，AD-16）
        const status = this.deps.system.getStatus();
        this.sendNow(sender, {
          v: PROTOCOL_VERSION,
          type: "session.snapshot",
          payload: {
            snapshot: toSnapshotDto(
              this.deps.session.getSnapshot(),
              status.model ?? "",
              status.agentState as AgentStateDto,
            ),
          },
        });
        return;
      }
      case "session.unsubscribe": {
        const sender = ws.data.sender;
        if (sender) this.deps.events.setSubscribed(sender, false);
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
      // ── v0.2 登记占位（契约 B §1 / C §1；iter-20260816-6q6f T1.2）──
      // 命令 type 已在协议目录登记、daemon 行为由 T2.1/T2.2/T2.3 落地：
      // 显式 case + command.unimplemented 占位回执（避免 default 兜底误报
      // command.unknown——区分「目录外」与「已登记未实现」）。既有 8 命令行为不变。
      case "session.list":
      case "session.loadHistory":
      case "session.delete":
        return this.commandError(ws, type, "command.unimplemented", `命令 ${type} 已登记（v0.2），daemon 行为待实现`);
      case "model.set":
      case "model.get":
      case "model.catalog":
      case "model.catalog_refresh":
      case "model.set_default":
      case "model.get_default":
        return this.commandError(ws, type, "command.unimplemented", `命令 ${type} 已登记（v0.2），daemon 行为待实现`);
      case "auth.list":
      case "auth.set_key":
      case "auth.delete_key":
      case "auth.verify":
        return this.commandError(ws, type, "command.unimplemented", `命令 ${type} 已登记（v0.2），daemon 行为待实现`);
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
