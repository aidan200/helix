import readline from "node:readline";
import type { SendOutcome, SessionChatPort } from "../../../application/ports/inbound/ChatPort";
import type { SessionPort } from "../../../application/ports/inbound/SessionPort";
import type { EventPublisherPort, StreamDelta } from "../../../application/ports/outbound/EventPublisherPort";
import type { DomainEvent } from "../../../domain/events/DomainEvent";
import type { AgentStateChangedPayload, MessageCompletedPayload, SteerPayload, ToolResultPayload } from "../../../domain/events/DomainEvent";

/**
 * StdoutEventPublisher —— EventPublisherPort 的 CLI 实现（driving 侧实现
 * outbound 的标准形态，architecture.md §3.4）：领域事件 → 终端可读行；
 * 流式 delta → 原样写出（打字机效果）。
 */
export class StdoutEventPublisher implements EventPublisherPort {
  constructor(private readonly output: NodeJS.WritableStream) {}

  publishDelta(delta: StreamDelta): void {
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

  private write(text: string): void {
    this.output.write(text);
  }
}

export interface CliAdapterDeps {
  readonly chat: SessionChatPort;
  readonly session: SessionPort;
  /** 事件发布器（组合根构造的 StdoutEventPublisher；本适配器不关心实现）。 */
  readonly events: EventPublisherPort;
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
  private readonly showPrompt: boolean;
  private agentState = "idle";
  private exitRequested: (() => void) | null = null;

  constructor(private readonly deps: CliAdapterDeps) {
    this.output = deps.output ?? process.stdout;
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
   * Ctrl-C 分流：生成中 → abort（abort 非销毁，会话可继续）；
   * 空闲/已中断 → 退出主循环（第二次 Ctrl-C 语义）。
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
    try {
      const outcome: SendOutcome = await this.deps.chat.sendMessage(text);
      if (outcome.mode === "turn") this.writeLine(""); // 新轮次换行，流式输出从行首开始
    } catch (err) {
      this.writeLine(`\n[错误] ${(err as Error).message}`);
    }
    this.prompt();
  }

  private prompt(): void {
    if (this.showPrompt) this.output.write("\nhelix> ");
  }

  private writeLine(text: string): void {
    this.output.write(`${text}\n`);
  }
}
