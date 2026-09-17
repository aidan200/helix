import type { ChildOutboundLine, ToolResponseLine } from "../transport/wire";

/**
 * RemoteAskPort —— 提权申请仲裁的进程外实现（permission_request 批，子进程侧）。
 *
 * 子进程零仲裁知识：permission_request 工具的 ask.request 调用序列化为
 * tool-req 行（method="ask.request"，args=[command, reason]）上 wire，
 * daemon 侧 SubagentLauncher 分流到父进程 AskService 单例仲裁（会话归属
 * 由父侧 instance 注册表裁决——子上行不携 sessionId，防伪造），
 * tool-res 回执按 reqId 关联 settle，value = 三终态 outcome。
 *
 * 转发超时 90s > 父侧 60s 机械超时——正常路径父侧恒回执（批准/拒绝/超时
 * 三终态都走 tool-res），90s 只兜 daemon 死亡/断线。
 *
 * 形态与 RemoteBrowserPort 同构（H-3 转发通道先例）。
 */
export const REMOTE_ASK_TIMEOUT_MS = 90_000;

interface PendingEntry {
  readonly resolve: (value: "approved" | "denied" | "timeout") => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class RemoteAskPort {
  private nextReqId = 1_000_000; // 与 RemoteBrowserPort 同通道——reqId 区间错开（父侧按行原样回显 reqId，区间隔离免互踩）
  private readonly pending = new Map<number, PendingEntry>();

  constructor(
    private readonly instanceId: string,
    private readonly writeLine: (line: ChildOutboundLine) => void,
    private readonly timeoutMs: number = REMOTE_ASK_TIMEOUT_MS,
  ) {}

  /** ChildMain stdin 路由馈入：reqId 关联 settle。未知/迟到 reqId 静默忽略。 */
  handleResponse(line: ToolResponseLine): void {
    const entry = this.pending.get(line.reqId);
    if (entry === undefined) return;
    this.pending.delete(line.reqId);
    clearTimeout(entry.timer);
    if (line.ok) entry.resolve(line.value as "approved" | "denied" | "timeout");
    else entry.reject(new Error(line.error));
  }

  /** 子进程退出清场：全部在飞申请以 reason 拒绝（定时器同清）。 */
  rejectAll(reason: string): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  /**
   * AskService.request 同形态适配（PermissionRequestToolDeps.ask 消费面）——
   * sessionId/instanceId 由装配面绑定传入但不上 wire（父侧以 instance
   * 注册表裁决会话归属，子上行只携 command/reason）。
   */
  request(input: { sessionId: string; instanceId: string; command: string; reason: string }): Promise<"approved" | "denied" | "timeout"> {
    const reqId = ++this.nextReqId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`ask 转发超时（${this.timeoutMs}ms 无 daemon 回执）`));
      }, this.timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      this.writeLine({
        type: "tool-req",
        instanceId: this.instanceId,
        reqId,
        method: "ask.request",
        args: [input.command, input.reason],
      });
    });
  }
}
