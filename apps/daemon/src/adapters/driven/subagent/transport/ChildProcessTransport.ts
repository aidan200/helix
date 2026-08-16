import { encodeLine, parseChildLine } from "./wire";
import type { ChildOutboundLine, SendLine } from "./wire";

/**
 * ChildProcessTransport —— 子进程 stdio 传输（O-7 候选 A，v1 同构最小集）。
 *
 * 职责（不含编排语义——那是 SubagentLauncher/调度侧的事）：
 * - stdout JSON 行读取（事件/收口/崩溃/诊断逐条上行回调）；
 * - stdin send 行写入（steer 注入，AD-7⑤）；
 * - O-6 kill 序列：SIGTERM 进程组（detached 子进程为组长，负 pid 命中
 *   全组含工具孙进程）→ grace 超时 SIGKILL 进程组 → 回收（ exited await
 *   完成 reap），零孤儿。
 */

/** O-6 缺省优雅等待（SIGTERM → SIGKILL 升级阈值）。 */
export const KILL_GRACE_MS = 3000;

export class ChildProcessTransport {
  readonly pid: number;
  readonly exited: Promise<number | null>;
  /** stdout 读取完成（EOF）——exit 后短暂等待行排空用。 */
  readonly drained: Promise<void>;

  private lineCb: ((line: ChildOutboundLine) => void) | undefined;
  private settled = false;

  constructor(
    private readonly proc: ReturnType<typeof Bun.spawn>,
    private readonly graceMs: number = KILL_GRACE_MS,
  ) {
    this.pid = proc.pid!;
    this.exited = new Promise<number | null>((resolve) => {
      void proc.exited.then((code) => {
        this.settled = true;
        resolve(code);
      });
    });
    this.drained = this.readStdout();
  }

  /** 注册 stdout 行回调（单订阅者；Launcher 侧转发）。 */
  onLine(cb: (line: ChildOutboundLine) => void): void {
    this.lineCb = cb;
  }

  /** send 行写入（steer 注入；子进程在 turn 边界 drain 消费）。 */
  send(text: string): void {
    (this.proc.stdin as { write: (s: string) => unknown }).write(encodeLine({ type: "send", text } satisfies SendLine));
  }

  /**
   * O-6 kill 序列：SIGTERM 进程组 → 等待 graceMs → 仍存活则 SIGKILL 进程组。
   * 返回实际路径（graceful=优雅退出；escalated=强杀）；进程已退出/不存在
   * 幂等返回 graceful。exited promise resolve 即完成 reap（组内无孤儿）。
   */
  async kill(): Promise<"graceful" | "escalated"> {
    if (this.settled) return "graceful"; // 已退出：幂等快速路径
    try {
      process.kill(-this.pid, "SIGTERM"); // 负 pid = 进程组
    } catch {
      return "graceful"; // 组已不存在（已退出）
    }
    if (await this.waitForExit(this.graceMs)) return "graceful";
    try {
      process.kill(-this.pid, "SIGKILL");
    } catch {
      /* 组已回收 */
    }
    await this.exited;
    return "escalated";
  }

  /** 等待退出至多 ms；true=期内退出。 */
  private waitForExit(ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      void this.exited.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /** stdout 行读取循环（EOF / 异常即结束）。 */
  private async readStdout(): Promise<void> {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      const stdout = this.proc.stdout as unknown as AsyncIterable<Uint8Array>;
      for await (const chunk of stdout) {
        buf += decoder.decode(chunk);
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const raw = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!raw) continue;
          const line = parseChildLine(raw);
          if (line) this.lineCb?.(line);
        }
      }
    } catch {
      /* stdout 异常关闭：exit 监视方兜底 */
    }
  }
}
