/**
 * shared/api —— helix WS 客户端（W7/CL-7；PROTOCOL.md §1/§2/§8/§9）。
 *
 * 职责（替换 desk shared/api 的三缝隙，不搬运）：
 * - token 获取：GET http://127.0.0.1:{port}/helix-dev-token（loopback Origin
 *   反射放行，vite dev 直用；§9）；
 * - 握手：WS open 后首帧 hello { token, protocolVersion: "0.3" }（T1.2 v0.3 bump 机械跟随，iter-20260818-mq5a）；
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

/** 默认 token 获取（§9）：loopback 端点，非 2xx 抛错（按连接失败计一次尝试）。 */
export async function fetchDevToken(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/helix-dev-token`);
  if (!res.ok) throw new Error(`dev-token endpoint HTTP ${res.status}`);
  const token = (await res.text()).trim();
  if (!token) throw new Error("dev-token endpoint returned empty body");
  return token;
}

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

export interface HelixWsClientOptions {
  port: number;
  getToken?: (port: number) => Promise<string>;
  transportFactory?: TransportFactory;
  backoff?: Partial<BackoffOptions>;
}

type Phase = "stopped" | "connecting" | "connected";

export class HelixWsClient {
  private readonly opts: Required<Pick<HelixWsClientOptions, "port" | "getToken" | "transportFactory">> &
    HelixWsClientOptions & { backoff: BackoffOptions };
  private phase: Phase = "stopped";
  private attempts = 0;
  private generation = 0; // stop() 递增：天折在逯的异步尝试（token fetch 竞态）
  private transport: Transport | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastErrorMessage: string | null = null;
  private readonly frameHandlers = new Set<(e: EventEnvelope) => void>();
  private readonly connHandlers = new Set<(c: ClientConnEvent) => void>();

  constructor(opts: HelixWsClientOptions) {
    this.opts = {
      ...opts,
      port: opts.port,
      getToken: opts.getToken ?? fetchDevToken,
      transportFactory: opts.transportFactory ?? browserTransportFactory,
      backoff: { ...DEFAULT_BACKOFF, ...opts.backoff },
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
    this.attempts = 0;
    void this.attemptConnect();
  }

  /** 用户主动关闭：不再重连（在逯 token fetch 一并天折）。 */
  stop(): void {
    this.clearTimer();
    this.generation += 1;
    this.phase = "stopped";
    this.transport?.close();
    this.transport = null;
  }

  /** 手动重试（error 态失败卡按钮）：清零尝试计数并立即重连。 */
  retry(): void {
    if (this.phase !== "stopped") return;
    this.clearTimer();
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
    this.emitConn({ kind: "connecting", attempt: this.attempts });

    let token: string;
    try {
      token = await this.opts.getToken(this.opts.port);
    } catch (err) {
      this.lastErrorMessage = `dev-token fetch failed (${(err as Error).message})`;
      this.handleFailure();
      return;
    }
    if (gen !== this.generation) return; // stop() 已天折本次尝试

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
      onMessage: (data) => this.handleMessage(data),
      onClose: (info) => this.handleClose(info),
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
      this.phase = "connected"; // 握手通过（快照将随后到达）
    }
    if (frame?.type === "connection.error") {
      const message = (frame.payload as { message?: string })?.message;
      if (message) this.lastErrorMessage = message;
    }
    this.emitFrame(frame);
  }

  private handleClose(_info: { code?: number; reason?: string }): void {
    if (this.phase === "stopped") return; // stop() 主动关闭
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
    this.phase = "stopped"; // 等待期；attemptConnect 会重新置 connecting
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.attemptConnect();
    }, this.delayFor());
  }
}
