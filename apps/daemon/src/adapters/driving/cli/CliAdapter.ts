import readline from "node:readline";
import type { SendOutcome, SessionChatPort } from "../../../application/ports/inbound/ChatPort";
import type { SessionPort } from "../../../application/ports/inbound/SessionPort";
import type { EventPublisherPort, StreamDelta } from "../../../application/ports/outbound/EventPublisherPort";
import type { DomainEvent } from "../../../domain/events/DomainEvent";
import type { AgentStateChangedPayload, MessageCompletedPayload, SteerDiscardedPayload, SteerPayload, ToolResultPayload } from "../../../domain/events/DomainEvent";

/**
 * GuardedWriter —— CLI stdout 守卫写面（低危批上收：StdoutEventPublisher.write
 * 与 CliAdapter.writeGuarded 曾各写一份同构三面守卫，单侧改动必漂移）。
 *
 * 三面（EPIPE 修复批② 事故链定式）：
 * ① 写前 writable/destroyed 检查（已销毁流直接跳过）；
 * ② 写同步异常 try/catch（任何情况不向上抛）；
 * ③ 异步 'error' 事件吸收（无监听时将成为进程级 uncaughtException 的路径）。
 * broken 后静默 no-op：终端可观测性让位于 daemon 存活（消费端已死，写无人读）。
 */
export class GuardedWriter {
  /** 降级标记：流已断（同步抛/异步 error/destroyed），后续写全部静默丢弃。 */
  private broken = false;

  constructor(private readonly output: NodeJS.WritableStream) {
    // 可选链防御非 EventEmitter 形态的注入流。
    (this.output as { on?: (event: string, listener: (err: Error) => void) => unknown }).on?.("error", () => {
      this.broken = true;
    });
  }

  /** 守卫写；broken/不可写/同步抛一律静默（返回是否实际写入）。 */
  write(text: string): boolean {
    if (this.broken) return false;
    const stream = this.output as NodeJS.WritableStream & { destroyed?: boolean; writable?: boolean };
    if (stream.destroyed === true || stream.writable === false) {
      this.broken = true; // 已销毁/不可写：直接降级（写必失败或无意义）
      return false;
    }
    try {
      this.output.write(text);
      return true;
    } catch {
      this.broken = true; // EPIPE 等同步写失败：降级标记，后续静默 no-op
      return false;
    }
  }

  get isBroken(): boolean {
    return this.broken;
  }
}

/**
 * StdoutEventPublisher —— EventPublisherPort 的 CLI 实现（driving 侧实现
 * outbound 的标准形态，architecture.md §3.4）：领域事件 → 终端可读行；
 * 流式 delta → 原样写出（打字机效果）。
 *
 * EPIPE 守卫（修复批②，2026-09-20 事故）：daemon sidecar 形态 stdout 消费端
 * （壳/管道读端）死亡 → process.stdout.write 抛 EPIPE uncaughtException →
 * daemon 崩溃（事故链上游：崩溃后续发前端重连死锁）。守卫三面：
 * ① 写前 writable/destroyed 检查（已销毁流直接跳过）；
 * ② 写同步异常 try/catch（任何情况不向上抛——FanoutPublisher M32 隔离面
 *    之外的直连调用方同样安全）；
 * ③ 异步 'error' 事件吸收（无监听时将成为进程级 uncaughtException 的路径）。
 * broken 后标记降级：后续 publish/publishDelta 静默 no-op（终端可观测性
 * 让位于 daemon 存活——stdout 消费端已死，写无人读无意义）。
 */
export class StdoutEventPublisher implements EventPublisherPort {
  /** 守卫写面（GuardedWriter 单点：三类失败面的唯一实现处）。 */
  private readonly writer: GuardedWriter;

  constructor(output: NodeJS.WritableStream) {
    this.writer = new GuardedWriter(output);
  }

  publishDelta(delta: StreamDelta): void {
    // diff 通道：结构化统计推送不进终端打字机流（WS 专用瞬态帧）
    if (delta.channel === "diff") return;
    this.write(delta.delta);
  }

  publish(event: DomainEvent): void {
    switch (event.type) {
      case "message.completed": {
        const p = event.payload as MessageCompletedPayload;
        if (p.role === "user") this.write(`\n你：${p.text}`);
        break;
      }
      case "steer.queued": {
        const p = event.payload as SteerPayload;
        this.write(`\n[steer] 已入队（当前 turn 结束后注入）：${p.text}`);
        break;
      }
      case "steer.drained": {
        const p = event.payload as SteerPayload;
        this.write(`\n[steer] 已注入并驱动新回复：${p.text}`);
        break;
      }
      case "steer.discarded": {
        const p = event.payload as SteerDiscardedPayload;
        this.write(
          `\n[steer] 队列出账（${p.reason === "buffered" ? "转续送" : "丢弃"} ${p.entryIds.length} 条）`,
        );
        break;
      }
      case "turn.completed":
        this.write("\n");
        break;
      case "turn.interrupted":
        this.write("\n[turn] 已中断\n");
        break;
      case "agent.state.changed": {
        const p = event.payload as AgentStateChangedPayload;
        if (p.state === "aborting") this.write("\n[abort] 已请求中断当前生成…");
        if (p.state === "idle") this.write("\n");
        break;
      }
      case "tool.call.result": {
        const p = event.payload as ToolResultPayload;
        this.write(`\n[tool] ${p.toolName} ${p.isError ? "失败" : "完成"}：${p.result.slice(0, 80)}`);
        break;
      }
      case "engine.error":
        this.write(`\n[engine-error] ${String((event.payload as { message: string }).message)}\n`);
        break;
      default:
        break;
    }
  }

  /** stdout 守卫写面（机制在 GuardedWriter：检查/同步抛/异步 error 三面）。 */
  private write(text: string): void {
    this.writer.write(text);
  }
}

export interface CliAdapterDeps {
  readonly chat: SessionChatPort;
  readonly session: SessionPort;
  /** 事件发布器（组合根构造的 StdoutEventPublisher；本适配器不关心实现）。 */
  readonly events: EventPublisherPort;
  /** M3-d1 感知兑现批：用户输入信号回调（非空非 /exit 对话行触发——组合根
   *  旁挂感知服务 noteUserActivity（在场信号，现仅认 GUI ask 的补齐）+
   *  活动账 noteCliSession（cli: 域标签会话来源登记）。**隔离面**：抛错
   *  被吞不炸主循环；缺席 = 零信号（回归兼容）。 */
  readonly onUserInput?: () => void;
  /** 输入流（默认 process.stdin；测试注入 PassThrough）。 */
  readonly input?: NodeJS.ReadableStream;
  /** 输出流（默认 process.stdout；测试注入 PassThrough）。 */
  readonly output?: NodeJS.WritableStream;
  /** 是否显示输入提示符（测试关闭以保证输出流纯净）。 */
  readonly showPrompt?: boolean;
  /** 是否安装进程信号处理（默认 true；测试 false 后直接调 interrupt()）。 */
  readonly installSignals?: boolean;
}

/**
 * CliAdapter —— CLI 驱动侧（architecture.md §3.5）：stdin 行 → ChatPort；
 * stdout 流式输出（经 StdoutEventPublisher）；Ctrl-C（SIGINT）→ 中断当前
 * 生成（空闲时第二次 Ctrl-C / EOF / /exit → 退出）。W4 验收载体。
 */
export class CliAdapter {
  private readonly output: NodeJS.WritableStream;
  /** 守卫写面（GuardedWriter 单点——与 StdoutEventPublisher 同一实现，
   *  终端消费端死亡后提示符/回显静默 no-op）。 */
  private readonly writer: GuardedWriter;
  private readonly showPrompt: boolean;
  private agentState = "idle";
  private exitRequested: (() => void) | null = null;

  constructor(private readonly deps: CliAdapterDeps) {
    this.output = deps.output ?? process.stdout;
    this.writer = new GuardedWriter(this.output);
    this.showPrompt = deps.showPrompt ?? true;
    // 从事件流跟踪 agent 状态（interrupt 分流依据：生成中→abort，空闲→退出）
    deps.session.subscribe((event) => {
      if ("type" in event && event.type === "agent.state.changed") {
        this.agentState = (event.payload as AgentStateChangedPayload).state;
      }
    });
  }

  /**
   * 主循环：readline 逐行读入。不 await 单次 sendMessage——生成中新行
   * 立即被 ChatService 路由为 steer 注入（多轮常驻语义）。
   */
  async run(): Promise<void> {
    this.writeLine(
      "helix daemon CLI —— 输入消息开始对话；/exit 退出；生成中输入将注入 steer 队列；Ctrl-C 中断当前生成",
    );
    if (this.deps.installSignals !== false) {
      process.on("SIGINT", () => this.interrupt());
    }
    const rl = readline.createInterface({ input: this.deps.input ?? process.stdin });
    const closed = new Promise<void>((resolve) => {
      this.exitRequested = resolve;
      rl.on("close", resolve);
    });
    rl.on("line", (line) => {
      void this.handleLine(line, rl);
    });
    this.prompt();
    await closed;
  }

  /**
   * Ctrl-C 分流：running/steering → abort（abort 非销毁，会话可继续）；
   * aborting 态 no-op（abort 已在途，不重发；abort 收尾回 idle 后再次
   * Ctrl-C 才退出——abort 卡住时仅剩 EOF// 命令可退）；空闲/已中断 →
   * 退出主循环（第二次 Ctrl-C 语义）。
   */
  interrupt(): void {
    if (this.agentState === "running" || this.agentState === "steering" || this.agentState === "aborting") {
      if (this.agentState !== "aborting") this.deps.chat.abort();
    } else {
      this.exitRequested?.();
    }
  }

  private async handleLine(line: string, rl: readline.Interface): Promise<void> {
    const text = line.trim();
    if (!text) return;
    if (text === "/exit" || text === "/quit") {
      rl.close();
      return;
    }
    // M3-d1：用户在场信号（非空对话行——CLI 终端与 GUI ask 同源点亮感知
    // 激活窗；回调面异常隔离不炸主循环）
    try {
      this.deps.onUserInput?.();
    } catch {
      // 感知旁挂面自身异常不阻断对话（组合根侧已 warn）
    }
    try {
      const outcome: SendOutcome = await this.deps.chat.sendMessage(text);
      // 轮次收尾换行（低危批口径更正）：sendMessage 的 Promise 在本轮 run 结束才
      // resolve（ChatPort 契约），此刻流式输出早已写完——这里补的是收尾空行，
      // 不是「让流式输出从行首开始」。
    } catch (err) {
      this.writeLine(`\n[错误] ${(err as Error).message}`);
    }
    this.prompt();
  }

  private prompt(): void {
    if (this.showPrompt) this.writeGuarded("\nhelix> ");
  }

  private writeLine(text: string): void {
    this.writeGuarded(`${text}\n`);
  }

  /** stdout 守卫写面（GuardedWriter 单点——CLI 主循环不因终端消费端死亡崩溃）。 */
  private writeGuarded(text: string): void {
    this.writer.write(text);
  }
}
