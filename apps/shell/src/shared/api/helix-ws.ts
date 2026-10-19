/**
 * shared/api —— helix WS 客户端（W7/CL-7；PROTOCOL.md §1/§2/§8/§9）。
 *
 * 职责（替换 desk shared/api 的三缝隙，不搬运）：
 * - token 获取：GET http://127.0.0.1:{port}/helix-dev-token（loopback Origin
 *   反射放行，vite dev 直用；§9）；
 * - 握手：WS open 后首帧 hello { token, protocolVersion: "0.14" }（v0.14 bump 机械跟随；契约 = PROTOCOL.md §2）；
 * - 重连退避状态机：断线 → 指数退避自动重连 → 重新握手 → 收快照（恢复语义
 *   在 reducer：快照 + 增量，本客户端只管连接生命周期）；
 * - transport 注入点：transportFactory 可注入 fake transport（M3 mock 挂点，
 *   test-design §5.4-3；测试见 helix-ws.test.ts）。
 *
 * 类型全部来自 @helix/protocol（AG-13 两端同源；仓库内禁平行协议定义）。
 */
import { PROTOCOL_VERSION } from "@helix/protocol";
import type { CommandEnvelope, EventEnvelope, HelloCommand } from "@helix/protocol";

// ── transport 抽象（注入点）──────────────────────────────────

export interface TransportHandlers {
  onOpen: () => void;
  onMessage: (data: string) => void;
  onClose: (info: { code?: number; reason?: string }) => void;
  onError: (err?: unknown) => void;
}

export interface Transport {
  connect(): void;
  send(data: string): void;
  close(): void;
}

export type TransportFactory = (url: string, handlers: TransportHandlers) => Transport;

/** 浏览器 WebSocket 实现（默认）。send 仅在 OPEN 态透传。 */
export function browserTransportFactory(url: string, handlers: TransportHandlers): Transport {
  let ws: WebSocket | null = null;
  return {
    connect() {
      ws = new WebSocket(url);
      ws.onopen = () => handlers.onOpen();
      ws.onmessage = (ev) => handlers.onMessage(String(ev.data));
      ws.onclose = (ev) => handlers.onClose({ code: ev.code, reason: ev.reason });
      ws.onerror = () => handlers.onError();
    },
    send(data) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    close() {
      ws?.close();
      ws = null;
    },
  };
}

/** 默认 token 获取（§9）旧注释位——实现已随修复批④上移。 */

// ── 客户端事件（连接生命周期；领域事件走 onFrame）────────────

export type ClientConnEvent =
  | { kind: "connecting"; attempt: number }
  | { kind: "disconnected" }
  | { kind: "gave-up"; message: string; attempts: number };

export interface BackoffOptions {
  /** 首次重试延迟；此后指数翻倍 */
  baseMs: number;
  /** 延迟上限 */
  maxMs: number;
  /** 自动重试次数上限（耗尽 → gave-up / error 态） */
  maxAttempts: number;
}

const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 800, maxMs: 8_000, maxAttempts: 5 };

/** 握手超时窗缺省（修复批④：10s）。 */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/** 默认 token 获取（§9）：loopback 端点，非 2xx 抛错（按连接失败计一次尝试）；
 *  signal 透传 fetch（握手超时AbortController 纳入面）。 */
export async function fetchDevToken(port: number, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/helix-dev-token`, { signal });
  if (!res.ok) throw new Error(`dev-token endpoint HTTP ${res.status}`);
  const token = (await res.text()).trim();
  if (!token) throw new Error("dev-token endpoint returned empty body");
  return token;
}

export interface HelixWsClientOptions {
  port: number;
  getToken?: (port: number, signal?: AbortSignal) => Promise<string>;
  transportFactory?: TransportFactory;
  backoff?: Partial<BackoffOptions>;
  /**
   * 握手超时窗 ms（修复批④）：从 emitConn("connecting") 起计时（含 token
   * fetch 阶段——AbortController 纳入），welcome 未到 → 计一次失败走既有
   * 退避/gave-up 链（connecting 态永不冻结）；缺省 10s；≤ 0 = 禁用。
   * 事故面：welcome 永不到达时 phase 永停 connecting，无重试无 gave-up
   * （用户看到「一直重连/连接中」冻结）。
   */
  handshakeTimeoutMs?: number;
  /**
   * 重连挂点（v0.3 T3.2，TR-AD-5）：握手通过（welcome）且本客户端此前已成功
   * 连接过时触发（首连不触发）。daemon 不持跨连接订阅状态（TR-AD-23③），
   * 消费方（SessionContext）在此重放全订阅图。同步调用点 phase 已置
   *   connected（send 可用）。
   */
  onReconnect?: () => void;
}

type Phase = "stopped" | "connecting" | "connected";

export class HelixWsClient {
  private readonly opts: Required<Pick<HelixWsClientOptions, "port" | "getToken" | "transportFactory">> &
    HelixWsClientOptions & { backoff: BackoffOptions; handshakeTimeoutMs: number };
  private phase: Phase = "stopped";
  private attempts = 0;
  private generation = 0; // stop() 递增：夭折在途的异步尝试（token fetch 竞态）
  private transport: Transport | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 握手超时计时器（修复批④：与退避 timer 分离——互不误清；welcome/停止/重试清理）。 */
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  /** 在飞 token fetch 的 abort 面握手超时（修复批④）。 */
  private tokenAbort: AbortController | null = null;
  /** 本次尝试已被握手超时收口（迟到的 close 回声不再计二次失败）。 */
  private attemptTimedOut = false;
  private lastErrorMessage: string | null = null;
  /** 曾成功握手标记：welcome 再临 = 重连（onReconnect 挂点判定） */
  private connectedOnce = false;
  private readonly frameHandlers = new Set<(e: EventEnvelope) => void>();
  private readonly connHandlers = new Set<(c: ClientConnEvent) => void>();

  constructor(opts: HelixWsClientOptions) {
    this.opts = {
      ...opts,
      port: opts.port,
      getToken: opts.getToken ?? fetchDevToken,
      transportFactory: opts.transportFactory ?? browserTransportFactory,
      backoff: { ...DEFAULT_BACKOFF, ...opts.backoff },
      handshakeTimeoutMs: opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    };
  }

  // ── 订阅面 ────────────────────────────────────────────────

  /** 协议事件帧（含 welcome/snapshot；由 reducer 投影）。 */
  onFrame(cb: (e: EventEnvelope) => void): () => void {
    this.frameHandlers.add(cb);
    return () => this.frameHandlers.delete(cb);
  }

  /** 连接生命周期事件（connecting / disconnected / gave-up）。 */
  onConn(cb: (c: ClientConnEvent) => void): () => void {
    this.connHandlers.add(cb);
    return () => this.connHandlers.delete(cb);
  }

  isConnected(): boolean {
    return this.phase === "connected";
  }

  // ── 生命周期 ──────────────────────────────────────────────

  /** 启动（幂等）：立即开始首次连接。 */
  start(): void {
    if (this.phase !== "stopped") return;
    this.clearTimer();
    this.clearHandshakeTimer();
    this.attempts = 0;
    void this.attemptConnect();
  }

  /** 用户主动关闭：不再重连（在途 token fetch 一并夭折）。 */
  stop(): void {
    this.clearTimer();
    this.clearHandshakeTimer();
    this.generation += 1;
    this.phase = "stopped";
    this.transport?.close();
    this.transport = null;
  }

  /** 手动重试（error 态失败卡按钮）：清零尝试计数并立即重连。 */
  retry(): void {
    if (this.phase !== "stopped") return;
    this.clearTimer();
    this.clearHandshakeTimer();
    this.attempts = 0;
    void this.attemptConnect();
  }

  /** 发送命令帧；握手完成前拒绝（返回 false）。 */
  send(cmd: CommandEnvelope): boolean {
    if (this.phase !== "connected" || !this.transport) return false;
    this.transport.send(JSON.stringify(cmd));
    return true;
  }

  // ── 内部：连接尝试与退避 ──────────────────────────────────

  private emitConn(c: ClientConnEvent): void {
    for (const cb of this.connHandlers) cb(c);
  }

  private emitFrame(e: EventEnvelope): void {
    for (const cb of this.frameHandlers) cb(e);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 握手超时计时器清理（修复批④：welcome 到达/停止/重试/新一轮尝试）。 */
  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  /** 握手超时武装：从 connecting 起计时（含 token fetch 阶段），超时收口本次尝试。 */
  private armHandshakeTimeout(): void {
    this.clearHandshakeTimer();
    if (this.opts.handshakeTimeoutMs <= 0) return; // 禁用（测试/特殊形态）
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      this.onHandshakeTimeout();
    }, this.opts.handshakeTimeoutMs);
  }

  /**
   * 握手超时收口（修复批④）：welcome 未到（含 token fetch 挂起）→ 计一次
   * 失败走既有退避/gave-up 链。分两形态：
   * - transport 已建（hello 已发/在途）：标记本次尝试已收口后主动断开，
   *   失败直接计（迟到的 close 事件回声被 attemptTimedOut 拦下不计二次）；
   * - token fetch 阶段（transport 未建）：AbortController 已 abort（在飞
   *   fetch 的迟到拒绝被 generation 守卫丢弃），直接计失败。
   * 非连接期触发（退避等待/已停）防御性忽略。
   */
  private onHandshakeTimeout(): void {
    if (this.phase !== "connecting") return;
    this.lastErrorMessage = `handshake timeout (no welcome within ${this.opts.handshakeTimeoutMs}ms)`;
    if (this.transport !== null) {
      this.attemptTimedOut = true;
      const stale = this.transport;
      this.transport = null;
      stale.close(); // 主动断开（不再冻结在 connecting 等待永不到来的 welcome）
      this.handleFailure();
      return;
    }
    // token fetch 阶段：abort 在飞 fetch（迟到拒绝被 generation 守卫丢弃），直接计失败
    this.tokenAbort?.abort();
    this.generation += 1;
    this.handleFailure();
  }

  private delayFor(): number {
    const { baseMs, maxMs } = this.opts.backoff;
    // 连接中断后置零（attempts=0）→ 首次重试即 base；连续失败按 2^(n-1) 递增
    if (this.attempts === 0) return baseMs;
    return Math.min(baseMs * 2 ** (this.attempts - 1), maxMs);
  }

  private async attemptConnect(): Promise<void> {
    const gen = this.generation;
    this.attempts += 1;
    this.phase = "connecting";
    this.attemptTimedOut = false;
    this.emitConn({ kind: "connecting", attempt: this.attempts });
    // 握手超时武装（修复批④）：token fetch 一并纳入计时（AbortController）
    const abort = new AbortController();
    this.tokenAbort = abort;
    this.armHandshakeTimeout();

    let token: string;
    try {
      token = await this.opts.getToken(this.opts.port, abort.signal);
    } catch (err) {
      if (gen !== this.generation) return; // stop()/超时已夭折本次尝试（F5 批 #4 + 修复批④：过期失败不得挂重连 timer）
      this.lastErrorMessage = `dev-token fetch failed (${(err as Error).message})`;
      this.handleFailure();
      return;
    } finally {
      if (this.tokenAbort === abort) this.tokenAbort = null;
    }
    if (gen !== this.generation) return; // stop()/超时已夭折本次尝试

    const url = `ws://127.0.0.1:${this.opts.port}`;
    const transport = this.opts.transportFactory(url, {
      onOpen: () => {
        const hello: HelloCommand = {
          v: PROTOCOL_VERSION,
          type: "hello",
          payload: { token, protocolVersion: PROTOCOL_VERSION },
        };
        transport.send(JSON.stringify(hello));
      },
      onMessage: (data) => {
        // 陈旧 transport 身份守卫（中危 F3a，E-83）：非当前连接的迟到帧（僵尸
        // welcome 可把 phase 翻 connected——握手完成前拒发保证被破）直接丢弃
        if (this.transport !== transport) return;
        this.handleMessage(data);
      },
      onClose: (info) => {
        // 陈旧 transport 身份守卫（同上）：迟到 close 不误计新尝试失败、不清其
        // 握手计时器（attemptTimedOut 是客户端级共享标志，不足以区分代次）
        if (this.transport !== transport) return;
        // 超时自清已收口的尝试：close 事件是自身断开的事后回声，不二次计失败
        if (this.attemptTimedOut) return;
        this.handleClose(info);
      },
      onError: () => {
        /* close 事件紧随其后，作为失败收口的唯一依据 */
      },
    });
    this.transport = transport;
    try {
      transport.connect();
    } catch (err) {
      this.lastErrorMessage = (err as Error).message;
      this.handleFailure();
    }
  }

  private handleMessage(data: string): void {
    let frame: EventEnvelope;
    try {
      frame = JSON.parse(data) as EventEnvelope;
    } catch {
      return; // 非 JSON 帧忽略（垃圾数据由 close 收口）
    }
    if (frame?.type === "connection.welcome") {
      this.clearHandshakeTimer(); // welcome 已到：握手计时器清除零副作用（修复批④）
      this.phase = "connected"; // 握手通过（快照将随后到达）
      if (this.connectedOnce) this.opts.onReconnect?.(); // 重连挂点（T3.2 全订阅图重放）
      this.connectedOnce = true;
    }
    if (frame?.type === "connection.error") {
      const message = (frame.payload as { message?: string })?.message;
      if (message) this.lastErrorMessage = message;
    }
    this.emitFrame(frame);
  }

  private handleClose(info: { code?: number; reason?: string }): void {
    if (this.phase === "stopped") return; // stop() 主动关闭
    this.clearHandshakeTimer(); // 握手期失败：计时器随失败收口拆除（防退避窗口内迟到触发）
    // close code/reason 记入 lastErrorMessage 供展示面消费（gave-up message
    // 消费）：异常断开（如 1006）无 connection.error 帧可依赖，这是唯一可见
    // 信号；但 error 帧已记的根因 message 优先，不被收尾事实覆盖
    if (this.lastErrorMessage === null) {
      const reason = typeof info.reason === "string" ? info.reason.trim() : "";
      const code = info.code ?? "unknown";
      this.lastErrorMessage = reason === "" ? `ws closed (code ${code})` : `ws closed (code ${code}): ${reason}`;
    }
    if (this.phase === "connected") {
      // 已连接过的断线：先交代 disconnected，再启动自动重连序列
      this.emitConn({ kind: "disconnected" });
      this.attempts = 0;
      this.scheduleReconnect();
      return;
    }
    this.handleFailure(); // 握手期失败（含 token 拒绝：error 帧后 close）
  }

  private handleFailure(): void {
    const { maxAttempts } = this.opts.backoff;
    if (this.attempts >= maxAttempts) {
      this.phase = "stopped";
      this.emitConn({
        kind: "gave-up",
        message: this.lastErrorMessage ?? "connection failed (retries exhausted)",
        attempts: this.attempts,
      });
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.clearTimer();
    this.clearHandshakeTimer(); // 旧尝试的握手计时器拆除（新尝试 attemptConnect 重新武装）
    this.phase = "stopped"; // 等待期；attemptConnect 会重新置 connecting
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.attemptConnect();
    }, this.delayFor());
  }
}
