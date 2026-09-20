/**
 * LoopEngine —— helix 自有 agent loop 执行循环（helix-loop L0 批；
 * docs/temp/helix-loop-design.md §4/§6）。
 *
 * 循环骨架（pi agent-loop 同构 + 暂停点原语）：
 * - 消息循环：streamFn 单步（流式回调透传）→ text 终答收口 / toolCall 进
 *   工具执行段；工具结果回灌窗口续跑至下一轮（工具轮上限熔断）；
 * - 暂停点原语：beforeToolCallPause 挂钩在工具执行前挂起 run（发
 *   loop.run.paused + 暂停凭据），外部 resumeWith(decision) 决定
 *   放行/改参/拒绝/外部已执行——确认闸的实现原语（pi 无「暂停后继续」）；
 * - abort：signal 只作用于 LLM 流式段（工具执行段不打断——duplex
 *   truncation §6.2；下一轮调用前检查），streamFn 返回 aborted 判别收口；
 * - 事件族：15 型 LoopEvent（pi 11 同构 + 4 扩展）经 emit 单通道发射——
 *   调用方投影（协议帧/domain_events/屏幕通道）零 loop 状态知识。
 *
 * 依赖纪律：domain 零 pi import——LLM 面即 LoopStreamFn duck-type 契约
 * （LoopTypes.ts），执行体在 driven adapter 装配注入。
 */
import type {
  LoopMessage,
  LoopResumeDecision,
  LoopRunInput,
  LoopStreamFn,
  LoopThinking,
  LoopToolCallContext,
  LoopToolOutcome,
} from "./LoopTypes";
import type { LoopEvent } from "./LoopEvent";
import { loopToolArgsSummary } from "./LoopEvent";
import type { LoopEventEmitter } from "./LoopTypes";
import type { ToolRegistry } from "./ToolRegistry";

/** run 收口判别（对外终态面）。 */
export type LoopRunResult =
  /** text 终答（含本轮 thinking 全精度）。 */
  | { readonly kind: "finished"; readonly text: string; readonly thinking?: LoopThinking }
  /** 暂停点挂起：resumeWith 决定放行/改参/拒绝/外部已执行（返回续跑 promise——
   *  续跑可能再次 paused（下一工具又挂闸），递归同构）。 */
  | {
      readonly kind: "paused";
      readonly pauseToken: string;
      readonly toolCall: { readonly id: string; readonly name: string; readonly args: Record<string, unknown> };
      readonly resumeWith: (decision: LoopResumeDecision) => Promise<LoopRunResult>;
    }
  /** 外部 resume 决策终结（confirm 执行体路径）。 */
  | { readonly kind: "resolved" }
  /** 工具轮上限熔断。 */
  | { readonly kind: "roundLimit"; readonly maxRounds: number }
  /** 错误收口（LLM 失败 / 工具 terminate / 超限详情文案）。 */
  | { readonly kind: "error"; readonly message: string }
  /** signal abort（新 ask 取代类——KV 已收尾，无 partial 入账）。 */
  | { readonly kind: "aborted" };

/** startRun 返回句柄。 */
export interface LoopRunHandle {
  readonly runId: string;
  readonly promise: Promise<LoopRunResult>;
}

/** 工具段继续信号（非终态——循环进下一轮）。 */
const CONTINUE = Symbol("loop-continue");
type ToolPhase = LoopRunResult | typeof CONTINUE;

/** run 内可变状态（暂停后跨 resume 续跑保持）。 */
interface RunState {
  readonly runId: string;
  readonly messages: LoopMessage[];
  turn: number;
  rounds: number;
}

export interface LoopEngineDeps {
  readonly streamFn: LoopStreamFn;
  readonly registry: ToolRegistry;
  /** 事件发射通道（同步回调——投影面单点）。 */
  readonly emit: LoopEventEmitter;
  /** runId 发号（缺省内部自增；测试注入）。 */
  readonly newRunId?: () => string;
}

export class LoopEngine {
  private readonly streamFn: LoopStreamFn;
  private readonly registry: ToolRegistry;
  private readonly emitEvent: LoopEventEmitter;
  private readonly newRunId: () => string;
  private pauseSeq = 0;

  constructor(deps: LoopEngineDeps) {
    this.streamFn = deps.streamFn;
    this.registry = deps.registry;
    this.emitEvent = deps.emit;
    this.newRunId = deps.newRunId ?? (() => `loop-run-${++LoopEngine.runSeq}`);
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
      // abort 检查（工具段不打断——本轮工具已收尾入账，此处安全退出）
      if (input.signal?.aborted === true) {
        this.emit({ type: "loop.run.finished", runId: state.runId, resolution: "aborted" });
        return { kind: "aborted" };
      }
      state.rounds += 1;
      if (state.rounds > input.maxRounds) {
        this.emit({ type: "loop.run.finished", runId: state.runId, resolution: "roundLimit" });
        return { kind: "roundLimit", maxRounds: input.maxRounds };
      }
      state.turn += 1;
      this.emit({ type: "loop.turn.started", runId: state.runId, turn: state.turn });
      this.emit({ type: "loop.message.started", runId: state.runId, turn: state.turn });

      let response: Awaited<ReturnType<LoopStreamFn>>;
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
        this.emit({ type: "loop.run.finished", runId: state.runId, resolution: "aborted" });
        return { kind: "aborted" };
      }
      const stopReason = response.kind === "toolCall" ? "toolUse" : "text";
      this.emit({ type: "loop.message.finished", runId: state.runId, turn: state.turn, stopReason });

      if (response.kind === "text") {
        const assistant: LoopMessage = {
          role: "assistant",
          text: response.text,
          ...(response.thinking !== undefined ? { thinking: response.thinking } : {}),
        };
        await this.recordMessage(state, input, assistant);
        this.emit({ type: "loop.turn.finished", runId: state.runId, turn: state.turn, stopReason: "text", tools: [] });
        this.emit({ type: "loop.run.finished", runId: state.runId, resolution: "answer" });
        return { kind: "finished", text: response.text, ...(response.thinking !== undefined ? { thinking: response.thinking } : {}) };
      }

      // 工具调用轮：assistant toolCall 消息的产生推迟到工具段分支（防火墙
      // 前置拒 terminate 分支零入账——与管家现状严格等价：propose_send 实例
      // 不运行路径直接 error 回执，KV 无痕）。
      const assistant: LoopMessage = {
        role: "assistant",
        ...(response.thinking !== undefined ? { thinking: response.thinking } : {}),
        toolCall: { id: response.id, name: response.name, args: response.args },
      };
      const ctx: LoopToolCallContext = {
        runId: state.runId,
        toolCallId: response.id,
        toolName: response.name,
        args: response.args,
      };
      const phase = await this.toolPhase(state, input, ctx, assistant);
      if (phase !== CONTINUE) return phase;
    }
  }

  /** 工具执行段：暂停判定 → pause 收口 / 执行 → 结果回灌继续。
   *  assistant toolCall 入账时点：非 terminate 分支在工具段开始前统一入账
   *  （确认闸挂起时工作记忆已可见——与管家现状等价：校验通过的提案先
   *  入账再等用户裁决）；terminate 分支零入账（防火墙前置拒无痕）。 */
  private async toolPhase(
    state: RunState,
    input: LoopRunInput,
    ctx: LoopToolCallContext,
    assistant: LoopMessage,
  ): Promise<ToolPhase> {
    if (input.beforeToolCallPause !== undefined) {
      const decision = await input.beforeToolCallPause(ctx);
      if (decision.pause) {
        this.emitToolStarted(state, input, ctx);
        await this.recordMessage(state, input, assistant);
        return this.pauseRun(state, input, ctx);
      }
      if (decision.outcome !== undefined) {
        if (decision.outcome.kind === "terminate") {
          return this.terminateRun(state, decision.outcome.reason);
        }
        this.emitToolStarted(state, input, ctx);
        await this.recordMessage(state, input, assistant);
        return this.applyToolOutcome(state, input, ctx, decision.outcome);
      }
    }
    this.emitToolStarted(state, input, ctx);
    await this.recordMessage(state, input, assistant);
    return this.executeTool(state, input, ctx);
  }

  /** tool.started 事件 + onToolStart 回调（过程可见——与管家迁移前序等价）。 */
  private emitToolStarted(state: RunState, input: LoopRunInput, ctx: LoopToolCallContext): void {
    const argsSummary = loopToolArgsSummary(ctx.args);
    this.emit({ type: "loop.tool.started", runId: state.runId, toolCallId: ctx.toolCallId, toolName: ctx.toolName, argsSummary });
    input.callbacks?.onToolStart?.(ctx.toolName, argsSummary);
  }

  /** 挂闸收口：发 run.paused，run promise settle paused（resumeWith 续跑）。 */
  private pauseRun(state: RunState, input: LoopRunInput, ctx: LoopToolCallContext): LoopRunResult {
    this.pauseSeq += 1;
    const pauseToken = `${state.runId}-pause-${this.pauseSeq}`;
    const argsSummary = loopToolArgsSummary(ctx.args);
    this.emit({
      type: "loop.run.paused",
      runId: state.runId,
      pauseToken,
      toolCallId: ctx.toolCallId,
      toolName: ctx.toolName,
      argsSummary,
    });
    const resumeWith = async (decision: LoopResumeDecision): Promise<LoopRunResult> => {
      this.emit({ type: "loop.run.resumed", runId: state.runId, pauseToken, decision: decision.kind });
      if (decision.kind === "resolve") {
        await this.appendToolResult(state, input, ctx, decision.text, decision.isError === true, decision.text);
        this.emit({ type: "loop.turn.finished", runId: state.runId, turn: state.turn, stopReason: "toolUse", tools: [ctx.toolName] });
        this.emit({ type: "loop.run.finished", runId: state.runId, resolution: "resolved" });
        return { kind: "resolved" };
      }
      if (decision.kind === "reject") {
        await this.appendToolResult(state, input, ctx, decision.text, true, decision.text);
        this.emit({ type: "loop.turn.finished", runId: state.runId, turn: state.turn, stopReason: "toolUse", tools: [ctx.toolName] });
        return this.driveLoop(state, input);
      }
      const args = decision.kind === "approveWith" ? decision.args : ctx.args;
      const nextCtx: LoopToolCallContext = { ...ctx, args };
      const outcome = await this.executeTool(state, input, nextCtx);
      if (outcome !== CONTINUE) return outcome;
      return this.driveLoop(state, input);
    };
    return {
      kind: "paused",
      pauseToken,
      toolCall: { id: ctx.toolCallId, name: ctx.toolName, args: ctx.args },
      resumeWith,
    };
  }

  /** registry 分发执行（异常/未知工具归一回灌——现状 wire 防御等价）。 */
  private async executeTool(state: RunState, input: LoopRunInput, ctx: LoopToolCallContext): Promise<ToolPhase> {
    const dispatched = await this.registry.dispatch(ctx.toolName, ctx.args, ctx);
    if (!dispatched.ok) {
      // 与管家迁移前文案等价（未知工具防御分支——LLM 只见注册表投影，结构性罕见）
      const text = `未知工具 ${ctx.toolName}`;
      await this.appendToolResult(state, input, ctx, text, true, text);
      this.emit({ type: "loop.turn.finished", runId: state.runId, turn: state.turn, stopReason: "toolUse", tools: [ctx.toolName] });
      return CONTINUE;
    }
    if (dispatched.outcome.kind === "terminate") {
      return this.terminateRun(state, dispatched.outcome.reason);
    }
    return this.applyToolOutcome(state, input, ctx, dispatched.outcome);
  }

  /** 防火墙前置拒（不回灌循环——run 错误收口直出回执）。 */
  private terminateRun(state: RunState, reason: string): LoopRunResult {
    this.emit({ type: "loop.run.error", runId: state.runId, message: reason });
    this.emit({ type: "loop.run.finished", runId: state.runId, resolution: "error" });
    return { kind: "error", message: reason };
  }

  /** 工具结果回灌 + 终态事件 + 循环继续。 */
  private async applyToolOutcome(
    state: RunState,
    input: LoopRunInput,
    ctx: LoopToolCallContext,
    outcome: Extract<LoopToolOutcome, { kind: "result" }>,
  ): Promise<ToolPhase> {
    await this.appendToolResult(state, input, ctx, outcome.text, outcome.isError === true, outcome.text, outcome.summary);
    this.emit({ type: "loop.turn.finished", runId: state.runId, turn: state.turn, stopReason: "toolUse", tools: [ctx.toolName] });
    return CONTINUE;
  }

  /** toolResult 入账（消息窗口 + 持久化回调 + tool.finished/onToolEnd 面——
   *  摘要优先 outcome.summary 覆盖面）。 */
  private async appendToolResult(
    state: RunState,
    input: LoopRunInput,
    ctx: LoopToolCallContext,
    text: string,
    isError: boolean,
    summarySource: string,
    summaryOverride?: string,
  ): Promise<void> {
    const message: LoopMessage = { role: "toolResult", toolCallId: ctx.toolCallId, name: ctx.toolName, text };
    await this.recordMessage(state, input, message);
    const base = summaryOverride ?? summarySource;
    const resultSummary = base.length <= 200 ? base : `${base.slice(0, 200)}…`;
    this.emit({
      type: "loop.tool.finished",
      runId: state.runId,
      toolCallId: ctx.toolCallId,
      toolName: ctx.toolName,
      isError,
      resultSummary,
    });
    input.callbacks?.onToolEnd?.(ctx.toolName, resultSummary);
  }

  /** 新消息入窗口 + 持久化回调（await 串行保序——调用方事实源同步面）。 */
  private async recordMessage(state: RunState, input: LoopRunInput, message: LoopMessage): Promise<void> {
    state.messages.push(message);
    await input.onNewMessage?.(message);
  }
}
