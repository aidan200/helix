/**
 * kernel/LoopKernel —— loop 域主循环本体（helix-loop Phase 0a 四层拆分；
 * 设计 §2.2：原 LoopEngine.driveLoop 独立成件）。
 *
 * 循环骨架（pi agent-loop 同构 + 暂停点原语；Phase 1 块模型——streamFn 终态
 * 为完整块集，kernel 自块集判别 turn 走向）
 * - 消息循环：streamFn 单步（流式回调透传）→ 无 toolCall 块即 text 终答收口 /
 *   含 toolCall 块进工具执行段（ToolPhase）；工具结果回灌窗口续跑至下一轮
 *   （工具轮上限熔断）；
 *   Phase 1 N=1 语义：多枚 toolCall 块时首枚执行、其余经 ToolPhase 合成
 *   error toolResult 回灌（I1 配对完整 + 模型可自纠；Phase 3 批执行接手）；
 * - abort：signal 只作用于 LLM 流式段（工具执行段不打断——duplex
 *   truncation §6.2；下一轮调用前检查），streamFn 返回 aborted 判别收口
 *   （善后委派 AbortSettler）；
 * - 轮边界压缩：经注入的 compactStep 回调（policy 层装配——kernel 零
 *   policy import，依赖单向 runtime→policy→kernel→contracts）；
 * - 事件族：15 型 LoopEvent 经 emit 单通道发射——调用方投影（协议帧/
 *   domain_events/屏幕通道）零 loop 状态知识。
 *
 * 依赖纪律：domain 零 pi import——LLM 面即 LoopStreamFn duck-type 契约
 * （contracts/stream.ts），执行体在 driven adapter 装配注入。
 */
import type { LoopEvent, LoopEventEmitter, LoopMessage, LoopContentBlock, LoopStreamFn, LoopToolCallContext } from "../contracts";
import { settleAbortedTurn } from "./AbortSettler";
import { recordMessage, type LoopRunHandle, type LoopRunInput, type LoopRunResult, type RunState } from "./RunState";
import { CONTINUE, ToolPhase } from "./ToolPhase";
import type { ToolRegistry } from "./ToolRegistry";

/** abort 原因提取（E-198：interrupted 事件 reason 面；AbortController.abort
 *  幂等——首个 reason 定格，重复信号零漂移，I5）。 */
function abortReasonOf(signal: AbortSignal | undefined): string {
  if (signal === undefined) return "aborted";
  const reason: unknown = signal.reason;
  if (typeof reason === "string" && reason !== "") return reason;
  if (reason instanceof Error && reason.message !== "") return reason.message;
  return "aborted";
}

export interface LoopKernelDeps {
  readonly streamFn: LoopStreamFn;
  readonly registry: ToolRegistry;
  /** 事件发射通道（同步回调——投影面单点）。 */
  readonly emit: LoopEventEmitter;
  /** runId 发号（缺省内部自增；测试注入）。 */
  readonly newRunId?: () => string;
  /** 轮边界压缩步（policy 层装配注入——LoopEngine 门面接线；缺省 = 无压缩）。 */
  readonly compactStep?: (state: RunState, input: LoopRunInput) => Promise<void>;
}

export class LoopKernel {
  private readonly streamFn: LoopStreamFn;
  private readonly tools: ToolPhase;
  private readonly emitEvent: LoopEventEmitter;
  private readonly newRunId: () => string;
  private readonly compactStep?: (state: RunState, input: LoopRunInput) => Promise<void>;

  constructor(deps: LoopKernelDeps) {
    this.streamFn = deps.streamFn;
    this.tools = new ToolPhase({ registry: deps.registry, emit: deps.emit });
    this.emitEvent = deps.emit;
    this.newRunId = deps.newRunId ?? (() => `loop-run-${++LoopKernel.runSeq}`);
    this.compactStep = deps.compactStep;
  }

  private static runSeq = 0;

  /** 启动 run（立即进入循环；返回句柄 promise 在终态/paused 时 settle）。 */
  startRun(input: LoopRunInput): LoopRunHandle {
    const runId = this.newRunId();
    const state: RunState = { runId, messages: [...input.messages], turn: 0, rounds: 0 };
    const promise = this.drive(state, input);
    return { runId, promise };
  }

  // ── 内部：循环体 ────────────────────────────────────────

  private emit(event: LoopEvent): void {
    this.emitEvent(event);
  }

  private async drive(state: RunState, input: LoopRunInput): Promise<LoopRunResult> {
    this.emit({ type: "loop.run.started", runId: state.runId, promptSummary: input.promptSummary ?? "" });
    return this.driveLoop(state, input);
  }

  private async driveLoop(state: RunState, input: LoopRunInput): Promise<LoopRunResult> {
    for (;;) {
      // abort 检查（工具段不打断——本轮工具已收尾入账，此处安全退出；轮已
      // 完整记账无 partial，E-198：interrupted 事件照发——run 终态序不变量）
      if (input.signal?.aborted === true) {
        this.emit({ type: "loop.run.interrupted", runId: state.runId, reason: abortReasonOf(input.signal) });
        this.emit({ type: "loop.run.finished", runId: state.runId, resolution: "aborted" });
        return { kind: "aborted" };
      }
      // 轮首序（R7.4 定稿）：abort 检查 → rounds 熔断 → 压缩 → turn.started →
      // drain+注入 → streamFn。熔断先于压缩与 drain：roundLimit 收口时队列
      // 零消费零压缩（G-G——drain 先于检查会在熔断收口时丢失已取走未注入
      // 的消息；压缩先于检查会在已注定收口的轮上浪费一次整窗替换）。
      state.rounds += 1;
      if (state.rounds > input.maxRounds) {
        this.emit({ type: "loop.run.finished", runId: state.runId, resolution: "roundLimit" });
        return { kind: "roundLimit", maxRounds: input.maxRounds };
      }
      // L1 件一：轮边界压缩检查（上轮结束→本轮 streamFn 前；首轮前同查——
      // 工作记忆跨 run 持久时首请求即需瘦身）。失败不抛（优化非依赖）。
      // 压缩先于 drain（R2.8）：drain 到的消息在压缩之后取走——永不被该次
      // 压缩裁掉（消息在注入前不进窗口）。
      await this.compactStep?.(state, input);
      state.turn += 1;
      this.emit({ type: "loop.turn.started", runId: state.runId, turn: state.turn });
      // steer 注入（R2.2 注入位：turn.started 后、streamFn 前；入账经
      // recordMessage 单写面——onNewMessage 同源；注入位恒在批 toolResult
      // 之后 R2.4）。
      if (input.drainSteering !== undefined) {
        const steering = input.drainSteering();
        if (steering !== undefined) await recordMessage(state, input, steering);
      }
      this.emit({ type: "loop.message.started", runId: state.runId, turn: state.turn });

      let response: Awaited<ReturnType<LoopStreamFn>>;
      // E-198：本轮流块完整收尾缓冲（块 end 凭证收集面——半截块无帧不进此；
      // Phase 1 块模型：载荷与 assistant content 块同一形状）
      const blocks: LoopContentBlock[] = [];
      try {
        response = await this.streamFn(
          {
            systemPrompt: input.systemPrompt,
            messages: [...state.messages], // 快照拷贝（调用方窗口不可变——防后续轮次 push 泄漏进已记录引用）
            tools: input.tools,
          },
          {
            onDelta: (chunk) => {
              this.emit({ type: "loop.message.delta", runId: state.runId, turn: state.turn, delta: chunk });
              input.callbacks?.onDelta?.(chunk);
            },
            onThinking: (block) => input.callbacks?.onThinking?.(block),
            onBlockEnd: (block) => {
              blocks.push(block);
            },
            ...(input.signal !== undefined ? { signal: input.signal } : {}),
          },
        );
      } catch (err) {
        const message = (err as Error).message;
        this.emit({ type: "loop.run.error", runId: state.runId, message });
        this.emit({ type: "loop.run.finished", runId: state.runId, resolution: "error" });
        return { kind: "error", message };
      }
      // 注：message.started 在 streamFn 调用前发射——消费面约定序
      // started → delta* → finished（单步 streamFn 契约下 delta 经回调透传）。
      if (response.kind === "aborted") {
        // E-198 打断善后：安全块入账 + 截断标记 + 不安全块丢弃（§2.1）——
        // 模型知道自己说过什么、被掐在哪；G1：半截 text（response.partialText）
        // 同批入账；interrupted 事件先于 finished。
        this.emit({ type: "loop.run.interrupted", runId: state.runId, reason: abortReasonOf(input.signal) });
        const audit = await settleAbortedTurn(
          (message) => recordMessage(state, input, message),
          blocks,
          response.partialText,
        );
        this.emit({ type: "loop.run.finished", runId: state.runId, resolution: "aborted" });
        return { kind: "aborted", ...(audit !== undefined ? { audit } : {}) };
      }
      // Phase 1 块模型：kernel 自块集判别 turn 走向（toolCall 块在即工具轮
      // ——stopReason 是模型侧意图声明，不作行为判据）。
      const toolCalls = response.blocks.filter((b): b is LoopContentBlock & { type: "toolCall" } => b.type === "toolCall");
      const stopReason = toolCalls.length > 0 ? "toolUse" : "text";
      this.emit({ type: "loop.message.finished", runId: state.runId, turn: state.turn, stopReason });

      if (toolCalls.length === 0) {
        // 终答轮：块集原样入账（单条 assistant——块序即流序，混排零拆分）。
        const assistant: LoopMessage = { role: "assistant", content: response.blocks };
        await recordMessage(state, input, assistant);
        this.emit({ type: "loop.turn.finished", runId: state.runId, turn: state.turn, stopReason: "text", tools: [] });
        // R2.5：终答轮后 steer 队列非空 → run 不收口，继续新 turn 消费
        // （pi 判例 agent-loop.js:90+187：while(hasMoreToolCalls ‖ pendingMessages)）。
        // 取走仍在轮首单 drain 点（R2.3 简化）——本处仅探测不消费。
        if (input.hasSteering?.() === true) continue;
        this.emit({ type: "loop.run.finished", runId: state.runId, resolution: "answer" });
        return { kind: "finished", blocks: response.blocks };
      }
      // 工具调用轮：assistant content 入账的产生推迟到工具段分支（防火墙
      // 前置拒 terminate 分支零入账——与管家现状严格等价：propose_send 实例
      // 不运行路径直接 error 回执，KV 无痕）。Phase 1 N=1 语义：首枚执行，
      // 其余经 ToolPhase 合成 error toolResult 回灌（I1 配对完整；Phase 3
      // 批执行接手）。
      const first = toolCalls[0]!;
      const extras = toolCalls.slice(1);
      const assistant: LoopMessage = { role: "assistant", content: response.blocks };
      const ctx: LoopToolCallContext = {
        runId: state.runId,
        toolCallId: first.id,
        toolName: first.name,
        args: first.args,
      };
      const phase = await this.tools.run(state, input, ctx, assistant, extras, () => this.driveLoop(state, input));
      if (phase !== CONTINUE) return phase;
    }
  }
}
