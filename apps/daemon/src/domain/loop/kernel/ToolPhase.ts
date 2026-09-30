/**
 * kernel/ToolPhase —— loop 域工具段（helix-loop Phase 0a 四层拆分；
 * 设计 §2.2：原 LoopEngine toolPhase/pauseRun/executeTool/applyToolOutcome/
 * appendToolResult 五方法独立成件；A1 批演进为批执行器的改造半径收敛点）。
 *
 * 工具段语义（Phase 0a 零行为变更——不变量 §4①②③）：
 * - 暂停闸 beforeToolCallPause 四态（approve/approveWith/reject/resolve，
 *   递归暂停同构）；挂闸时 assistant toolCall 已入账（工作记忆可见）；
 * - 挂闸内前置校验（pause:false + outcome 跳过 handler 直接回灌）；
 * - terminate 防火墙（零入账直出 error 回执——不回灌循环）；
 * - registry 分发 + 结果回灌续跑（resume 续跑经注入的 resume 续接主循环
 *   ——LoopKernel.driveLoop 闭包，本件不感知主循环本体）。
 *
 * 依赖纪律：本件只 import contracts（不 import policy——压缩挂点在
 * LoopKernel 轮边界，与本件无关）。
 */
import type {
  LoopEvent,
  LoopEventEmitter,
  LoopMessage,
  LoopResumeDecision,
  LoopToolCallContext,
  LoopToolOutcome,
} from "../contracts";
import { loopToolArgsSummary } from "../contracts/event";
import type { ToolRegistry } from "./ToolRegistry";
import { recordMessage, type LoopRunInput, type LoopRunResult, type RunState } from "./RunState";

/** 工具段继续信号（非终态——循环进下一轮）。 */
export const CONTINUE = Symbol("loop-continue");
export type ToolPhaseResult = LoopRunResult | typeof CONTINUE;

/** 工具段执行器（pauseSeq 引擎实例级——跨 run 递增，pauseToken 唯一性）。 */
export class ToolPhase {
  private readonly registry: ToolRegistry;
  private readonly emitEvent: LoopEventEmitter;
  private pauseSeq = 0;

  constructor(deps: { readonly registry: ToolRegistry; readonly emit: LoopEventEmitter }) {
    this.registry = deps.registry;
    this.emitEvent = deps.emit;
  }

  private emit(event: LoopEvent): void {
    this.emitEvent(event);
  }

  /** 工具执行段入口：暂停判定 → pause 收口 / 执行 → 结果回灌继续。
   *  assistant toolCall 入账时点：非 terminate 分支在工具段开始前统一入账
   *  （确认闸挂起时工作记忆已可见——与管家现状等价：校验通过的提案先
   *  入账再等用户裁决）；terminate 分支零入账（防火墙前置拒无痕）。
   *  resume = 主循环续接闭包（暂停恢复后回灌进下一轮——LoopKernel 注入）。 */
  async run(
    state: RunState,
    input: LoopRunInput,
    ctx: LoopToolCallContext,
    assistant: LoopMessage,
    resume: () => Promise<LoopRunResult>,
  ): Promise<ToolPhaseResult> {
    if (input.beforeToolCallPause !== undefined) {
      const decision = await input.beforeToolCallPause(ctx);
      if (decision.pause) {
        this.emitToolStarted(state, input, ctx);
        await recordMessage(state, input, assistant);
        return this.pauseRun(state, input, ctx, resume);
      }
      if (decision.outcome !== undefined) {
        if (decision.outcome.kind === "terminate") {
          return this.terminateRun(state, decision.outcome.reason);
        }
        this.emitToolStarted(state, input, ctx);
        await recordMessage(state, input, assistant);
        return this.applyToolOutcome(state, input, ctx, decision.outcome);
      }
    }
    this.emitToolStarted(state, input, ctx);
    await recordMessage(state, input, assistant);
    return this.executeTool(state, input, ctx);
  }

  /** tool.started 事件 + onToolStart 回调（过程可见——与管家迁移前序等价）。 */
  private emitToolStarted(state: RunState, input: LoopRunInput, ctx: LoopToolCallContext): void {
    const argsSummary = loopToolArgsSummary(ctx.args);
    this.emit({ type: "loop.tool.started", runId: state.runId, toolCallId: ctx.toolCallId, toolName: ctx.toolName, argsSummary });
    input.callbacks?.onToolStart?.(ctx.toolName, argsSummary);
  }

  /** 挂闸收口：发 run.paused，run promise settle paused（resumeWith 续跑）。 */
  private pauseRun(
    state: RunState,
    input: LoopRunInput,
    ctx: LoopToolCallContext,
    resume: () => Promise<LoopRunResult>,
  ): LoopRunResult {
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
        return resume();
      }
      const args = decision.kind === "approveWith" ? decision.args : ctx.args;
      const nextCtx: LoopToolCallContext = { ...ctx, args };
      const outcome = await this.executeTool(state, input, nextCtx);
      if (outcome !== CONTINUE) return outcome;
      return resume();
    };
    return {
      kind: "paused",
      pauseToken,
      toolCall: { id: ctx.toolCallId, name: ctx.toolName, args: ctx.args },
      resumeWith,
    };
  }

  /** registry 分发执行（异常/未知工具归一回灌——现状 wire 防御等价）。 */
  private async executeTool(state: RunState, input: LoopRunInput, ctx: LoopToolCallContext): Promise<ToolPhaseResult> {
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
  ): Promise<ToolPhaseResult> {
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
    await recordMessage(state, input, message);
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
}
