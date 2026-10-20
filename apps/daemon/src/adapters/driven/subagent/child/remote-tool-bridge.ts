import type { ChildOutboundLine, ToolResponseLine } from "../transport/wire";

/**
 * RemoteToolBridge —— 子进程侧 tool-req/tool-res 转发的共同引擎（低危批上收）。
 *
 * RemoteBrowserPort（H-3 转发通道）与 RemoteAskPort（permission_request 仲裁
 * 转发）的 pending 表 / 请求号分配 / 超时定时器 / 回执关联 / 退出清场原本各写
 * 一遍（~50 行同构），两份各自维护超时与清理语义，单侧修正必漏另一侧。
 * 本模块是这段机制的唯一实现；两端口只保留「方法名 + 参数形状 + 超时文案」。
 *
 * 契约（改动前先看）：
 * - reqId 单调递增，起点由调用方给（两端口区间错开：父侧按行原样回显 reqId，
 *   区间隔离免互踩）；
 * - 超时：定时器到点即从 pending 摘除并 reject（迟到回执随后静默）；
 * - handleResponse：未知/迟到 reqId 静默忽略，ok:false → reject(error 文案)；
 * - rejectAll：退出清场，在飞全拒（定时器同清），不回写 wire。
 */

/** 在飞请求条目（settle 三件套：resolve/reject/定时器）。 */
interface PendingEntry {
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** 构造参数：两端口差异面只有 reqId 起点与超时文案。 */
export interface RemoteToolBridgeOptions {
  readonly instanceId: string;
  readonly writeLine: (line: ChildOutboundLine) => void;
  readonly timeoutMs: number;
  /** 首个 reqId 的起点（call 内部先自增，故首个 reqId = firstReqId + 1）。 */
  readonly firstReqId: number;
  /** 超时文案（方法名入参：转发类带方法名，问答类不带）。 */
  readonly timeoutMessage: (method: string) => string;
}

export class RemoteToolBridge {
  private nextReqId: number;
  private readonly pending = new Map<number, PendingEntry>();

  constructor(private readonly options: RemoteToolBridgeOptions) {
    this.nextReqId = options.firstReqId;
  }

  /** stdin 路由馈入：按 reqId 关联 settle（未知/迟到静默）。 */
  handleResponse(line: ToolResponseLine): void {
    const entry = this.pending.get(line.reqId);
    if (entry === undefined) return; // 迟到/未知回执：pending 已清（超时/清场），静默
    this.pending.delete(line.reqId);
    clearTimeout(entry.timer);
    if (line.ok) entry.resolve(line.value);
    else entry.reject(new Error(line.error));
  }

  /** 退出清场：全部在飞请求以 reason 拒绝（定时器同清）。 */
  rejectAll(reason: string): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  /** 转发单点：reqId 递增 → pending 登记 → tool-req 上 wire → 等 tool-res。 */
  call<T>(method: string, args: readonly unknown[]): Promise<T> {
    const reqId = ++this.nextReqId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(this.options.timeoutMessage(method)));
      }, this.options.timeoutMs);
      this.pending.set(reqId, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.options.writeLine({ type: "tool-req", instanceId: this.options.instanceId, reqId, method, args });
    });
  }
}
