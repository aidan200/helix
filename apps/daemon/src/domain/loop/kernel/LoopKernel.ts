/**
 * kernel/LoopKernel —— loop 域主循环本体（helix-loop Phase 0a 四层拆分；
 * 设计 §2.2：原 LoopEngine.driveLoop 独立成件）。
 *
 * 循环骨架（pi agent-loop 同构 + 暂停点原语；Phase 3 批工具：批 = 本轮
 * assistant content 全部 toolCall 块，工具段整批委派 ToolPhase 批执行器
 * ——preflight 逐枚 → 并发启动 → 完成序事件 → 源序入账，暂停闸/防火墙/
 * abort 按批语义收口；R7 轮计数 per LLM 请求（N 枚批 = 1 轮，迭代结构不变）
 * - 消息循环：streamFn 单步（流式回调透传）→ 无 toolCall 块即 text 终答收口 /
 *   含 toolCall 块进工具执行段（length 截断批经 ToolPhase 全 fail 零执行 R5.5）；
 *   工具结果回灌窗口续跑至下一轮（工具轮上限熔断）；
 * - abort：signal 尽力传播（R4.2：流式段 + 工具 ctx + 挂闸面）；批收口等
 *   全部在飞枚 settle 后直收 aborted（R4.6/D8）；streamFn 返回 aborted 判别
 *   收口（善后委派 AbortSettler——E-198 现行不动）；
 * - 轮边界压缩：经注入的 compactStep 回调（policy 层装配——kernel 零
 *   policy import，依赖单向 runtime→policy→kernel→contracts）；
 * - 事件族：15 型 LoopEvent 经 emit 单通道发射——调用方投影（协议帧/
 *   domain_events/屏幕通道）零 loop 状态知识。
 *
 * 依赖纪律：domain 零 pi import——LLM 面即 LoopStreamFn duck-type 契约
 * （contracts/stream.ts），执行体在 driven adapter 装配注入。
 */
import type { LoopEvent, LoopEventEmitter, LoopMessage, LoopContentBlock, LoopStreamFn } from "../contracts";
import { settleAbortedTurn } from "./AbortSettler";
import { abortReasonOf, recordMessage, type LoopRunHandle, type LoopRunInput, type LoopRunResult, type RunState } from "./RunState";
import { CONTINUE, ToolPhase } from "./ToolPhase";
import type { ToolRegistry } from "./ToolRegistry";

// abort 原因提取已归位 RunState.ts（kernel 共享 util：轮首检查与 ToolPhase 批收口同源）

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
      // abort 检查（轮首序 R7.4 首位；批语义下工具段已直收 aborted——本检查
      // 覆盖批收口 CONTINUE 后、下一轮 streamFn 前置位的 abort；轮已完整
      // 记账无 partial，E-198：interrupted 事件照发——run 终态序不变量）
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
      // 工具调用轮（Phase 3 批语义）：批 = 本轮 content 全部 toolCall 块（源序，
      // 上方已判别）整批进 ToolPhase；assistant content 入账时机由批执行器决定
      // （首闸挂起时工作记忆可见 / 批收口源序入账；gate 前置拒防火墙零入账
      // 判例在批内有已决结果时让位 I1）。length 截断（R5.5）：stopReason=length
      // 且含 toolCall 块 → 全 fail 零执行（模型可重发）——批判别与 stopReason
      // 联动的唯一例外位。
      const assistant: LoopMessage = { role: "assistant", content: response.blocks };
      const phase = await this.tools.run(state, input, toolCalls, assistant, () => this.driveLoop(state, input), {
        truncated: response.stopReason === "length",
      });
      if (phase !== CONTINUE) return phase;
    }
  }
}
