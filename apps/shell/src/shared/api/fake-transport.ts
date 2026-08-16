/**
 * fake transport 标准实现（T4.4；F 层 mock mode 唯一 mock 模块）。
 *
 * 装配路径：SessionProvider 按 fakeTransportScript()（env/URL 双形态）经
 * HelixWsClient 既有 TransportFactory 注入点动态 import 本模块——复用接缝
 * 不新开旁路；生产构建 define 摇除后本模块不进 bundle（T4.4 验收项）。
 *
 * 契约等价纪律（TR-TEST-5 既有）：
 * - fake 实例保留 WebSocket 静态常量（CONNECTING/OPEN/CLOSING/CLOSED），
 *   send 仅 OPEN 态透传（readyState 门控）；
 * - 非 daemon 地址（vite HMR 等）透传真实 browserTransportFactory；
 * - 帧结构由调用方（e2e/harness/protocol.ts）直引 @helix/protocol 构造，
 *   本模块零帧知识。
 *
 * 控制面 `window.__helixMock`：与首迭代 addInitScript 版（harness/mock-init.ts，
 * 现退役为兼容路径）API 完全一致（open/emit/emitAll/netClose/failHandshake/
 * clientFrames/activeCount），spec 经 page.evaluate 驱动剧本回放；连接状态机/
 * 退避/握手全部走生产 HelixWsClient 真实路径。
 *
 * 剧本模块（URL 形态）：`?fakeTransport=<module-url>` 时加载该 ES 模块，
 * default export 收到控制面 API（自动剧本驱动器；如 smoke 的 auto-connect）。
 */
import type { CommandEnvelope, EventEnvelope } from "@helix/protocol";
import { browserTransportFactory, type Transport, type TransportFactory, type TransportHandlers } from "./helix-ws";

/** daemon 回环地址前缀（非该前缀 → 真实 WebSocket 透传，HMR 不受扰）。 */
const DAEMON_WS_PREFIX = "ws://127.0.0.1:";

// ── 控制面（window.__helixMock；API 与 mock-init 兼容路径逐字对齐）────

export interface HelixMockApi {
  open(): Promise<void>;
  emit(frame: EventEnvelope): Promise<void>;
  emitAll(frames: EventEnvelope[]): Promise<void>;
  netClose(code?: number): Promise<void>;
  failHandshake(): Promise<void>;
  clientFrames(): (CommandEnvelope | null)[];
  activeCount(): number;
}

interface ClientWaiter {
  type: string;
  resolve(frame: CommandEnvelope): void;
}

/** fake 实例（WebSocket 形状：readyState + 静态常量 + send 门控）。 */
class FakeSocket {
  /** WebSocket 静态常量必须保留：readyState 门控按此判（TR-TEST-5）。 */
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = FakeSocket.CONNECTING;

  constructor(
    url: string,
    private readonly handlers: TransportHandlers,
    private readonly registry: Registry,
  ) {
    this.url = url;
  }

  /** 仅 OPEN 态透传（readyState 门控； CONNECTING 期帧按 WebSocket 语义丢弃）。 */
  send(data: string): void {
    if (this.readyState !== FakeSocket.OPEN) return;
    let frame: CommandEnvelope | null = null;
    try {
      frame = JSON.parse(data) as CommandEnvelope;
    } catch {
      frame = null;
    }
    this.registry.clientFrames.push(frame);
    const hit: ClientWaiter[] = [];
    const rest: ClientWaiter[] = [];
    for (const w of this.registry.commandWaiters) (w.type === frame?.type ? hit : rest).push(w);
    this.registry.commandWaiters = rest;
    for (const w of hit) w.resolve(frame!);
  }

  /** 用户侧主动关闭（stop/retry）：不出网络事件（与 mock-init 口径一致）。 */
  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }

  // ── 控制面驱动（spec 侧）─────────────────────────────────

  fireOpen(): void {
    this.readyState = FakeSocket.OPEN;
    this.handlers.onOpen();
  }

  fireMessage(frame: EventEnvelope): void {
    this.handlers.onMessage(JSON.stringify(frame));
  }

  fireClose(code: number): void {
    this.readyState = FakeSocket.CLOSED;
    this.handlers.onClose({ code, reason: "" });
  }

  fireError(): void {
    this.handlers.onError();
  }
}

/** 实例注册表（模块级单例：同页多连接尝试共享，控制面观测全部实例）。 */
class Registry {
  readonly instances: FakeSocket[] = [];
  readonly clientFrames: (CommandEnvelope | null)[] = [];
  commandWaiters: ClientWaiter[] = [];
  private instanceWaiters: ((inst: FakeSocket) => void)[] = [];

  activeInstance(): FakeSocket | null {
    const alive = this.instances.filter((i) => i.readyState !== FakeSocket.CLOSED);
    return alive.length ? alive[alive.length - 1]! : null;
  }

  nextActive(): Promise<FakeSocket> {
    return new Promise((resolve) => {
      const inst = this.activeInstance();
      if (inst) resolve(inst);
      else this.instanceWaiters.push(resolve);
    });
  }

  register(inst: FakeSocket): void {
    this.instances.push(inst);
    for (const w of this.instanceWaiters.splice(0)) w(inst);
  }
}

// ── 模块入口（动态 import 消费）────────────────────────────

const registry = new Registry();

/** 剧本模块（URL 形态）懒加载：default export 收到控制面 API。 */
function loadDriverScript(script: string): void {
  if (script === "1") return; // 默认剧本：无外部驱动器，spec 手动驱动
  void import(/* @vite-ignore */ script)
    .then((m: { default?: (api: HelixMockApi) => void | Promise<void> }) => {
      if (typeof m.default === "function") void m.default(mockApi);
    })
    .catch(() => {
      // 剧本模块加载失败：控制面仍在（spec 手动驱动兜底），仅放弃自动剧本
    });
}

/** 控制面实例（挂 window + 供剧本模块消费）。 */
const mockApi: HelixMockApi = {
  async open() {
    (await registry.nextActive()).fireOpen();
  },
  async emit(frame) {
    (await registry.nextActive()).fireMessage(frame);
  },
  async emitAll(frames) {
    const inst = await registry.nextActive();
    for (const f of frames) inst.fireMessage(f);
  },
  async netClose(code) {
    (await registry.nextActive()).fireClose(code == null ? 1006 : code);
  },
  async failHandshake() {
    const inst = await registry.nextActive();
    inst.fireError();
    inst.fireClose(1006);
  },
  clientFrames() {
    return registry.clientFrames.slice();
  },
  activeCount() {
    return registry.instances.filter((i) => i.readyState !== FakeSocket.CLOSED).length;
  },
};

declare global {
  interface Window {
    __helixMock?: HelixMockApi;
  }
}

if (typeof window !== "undefined") {
  window.__helixMock = mockApi;
}

let driverLoaded = false;

/**
 * fake transport 工厂（TransportFactory 形状，HelixWsClient 注入点消费）。
 *
 * @param script 剧本入口（"1" = 默认；否则剧本模块 URL，首次建连时加载）
 */
export function createFakeTransport(script: string): TransportFactory {
  return (url: string, handlers: TransportHandlers): Transport => {
    if (typeof url !== "string" || !url.startsWith(DAEMON_WS_PREFIX)) {
      // 非 daemon 地址透传真实 WebSocket（TR-TEST-5：HMR 等不受 mock 扰动）
      return browserTransportFactory(url, handlers);
    }
    if (!driverLoaded) {
      driverLoaded = true;
      loadDriverScript(script);
    }
    const socket = new FakeSocket(url, handlers, registry);
    registry.register(socket);
    return {
      connect() {
        /* 连接由剧本驱动：spec 经 __helixMock.open() 触发（或自动剧本模块） */
      },
      send(data) {
        socket.send(data);
      },
      close() {
        socket.close();
      },
    };
  };
}
