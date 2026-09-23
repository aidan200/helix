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
  LoopAbortAudit,
  LoopAbortDroppedBlock,
  LoopCompactionInfo,
  LoopCompactionOptions,
  LoopMessage,
  LoopResumeDecision,
  LoopRunInput,
  LoopStreamBlock,
  LoopStreamFn,
  LoopThinking,
  LoopToolCallContext,
  LoopToolOutcome,
} from "./LoopTypes";
import type { LoopEvent } from "./LoopEvent";
import { loopToolArgsSummary } from "./LoopEvent";
import { estimateLoopTokens, planCompactionWindow } from "./LoopCompaction";
import { LOOP_INTERRUPTED_MARKER_TEXT, LOOP_INTERRUPTED_TOOL_RESULT_TEXT } from "./LoopTypes";
import type { LoopEventEmitter } from "./LoopTypes";
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
  /** signal abort（新 ask 取代类）——E-198 partial 保留：安全块已入账 +
   *  截断标记；半截 text 入账（G1：partialText 并入尾批文本），半截
   *  thinking/toolCall 丢弃（audit = I6 审计摘要，无入账且无丢弃时缺席）。 */
  | { readonly kind: "aborted"; readonly audit?: LoopAbortAudit };

/** startRun 返回句柄。 */
export interface LoopRunHandle {
  readonly runId: string;
  readonly promise: Promise<LoopRunResult>;
}

/** 工具段继续信号（非终态——循环进下一轮）。 */
const CONTINUE = Symbol("loop-continue");
type ToolPhase = LoopRunResult | typeof CONTINUE;

/** run 内可变状态（暂停后跨 resume 续跑保持；messages 引用稳定——压缩
 *  整窗替换也在同引用上重排）。 */
interface RunState {
  readonly runId: string;
  messages: LoopMessage[];
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
  /** L1 件一：上下文压缩（阈值触发 + 滚动窗保留 + 配对保护；缺省 = 无压缩）。 */
  readonly compaction?: LoopCompactionOptions;
}

export class LoopEngine {
  private readonly streamFn: LoopStreamFn;
  private readonly registry: ToolRegistry;
  private readonly emitEvent: LoopEventEmitter;
  private readonly newRunId: () => string;
  private readonly compaction?: LoopCompactionOptions;
  private pauseSeq = 0;

  constructor(deps: LoopEngineDeps) {
    this.streamFn = deps.streamFn;
    this.registry = deps.registry;
    this.emitEvent = deps.emit;
    this.newRunId = deps.newRunId ?? (() => `loop-run-${++LoopEngine.runSeq}`);
    this.compaction = deps.compaction;
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

  /** L1 件一：轮边界压缩（阈值判定 → 摘要 → 窗口替换 + 事件 + 调用方同步）。
   *  失败语义：summarize 抛错/空摘要 → 事件记 failed + 保留原窗口继续
   *  （调用方粗裁剪兑底）——永不抛出、永不阻塞对话（压缩是优化不是依赖）。 */
  private async maybeCompact(state: RunState, input: LoopRunInput): Promise<void> {
    const compaction = this.compaction;
    if (compaction === undefined) return;
    const tokensBefore = estimateLoopTokens(state.messages);
    if (tokensBefore <= compaction.thresholdTokens) return;
    const plan = planCompactionWindow(state.messages, {
      thresholdTokens: compaction.thresholdTokens,
      keepRecent: compaction.keepRecent,
    });
    if (plan === null) return;
    let summary: string;
    try {
      summary = await compaction.summarize(state.messages.slice(0, plan.compactFrom));
    } catch (err) {
      this.emit({
        type: "loop.context.compacted",
        runId: state.runId,
        status: "failed",
        tokensBefore,
        error: (err as Error).message,
      });
      return;
    }
    if (summary.trim() === "") {
      this.emit({
        type: "loop.context.compacted",
        runId: state.runId,
        status: "failed",
        tokensBefore,
        error: "压缩摘要为空",
      });
      return;
    }
    const summaryMessage = { role: "user" as const, text: summary, compaction: true as const };
    const kept = state.messages.slice(plan.compactFrom);
    state.messages = [summaryMessage, ...kept];
    const tokensAfter = estimateLoopTokens(state.messages);
    this.emit({
      type: "loop.context.compacted",
      runId: state.runId,
      status: "completed",
      tokensBefore,
      tokensAfter,
      summary: summary.slice(0, 200),
    });
    const info: LoopCompactionInfo = {
      summaryMessage,
      keptMessages: kept,
      droppedCount: plan.compactFrom,
      tokensBefore,
      tokensAfter,
    };
    await input.onCompacted?.(info);
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
      // L1 件一：轮边界压缩检查（上轮结束→本轮 streamFn 前；首轮前同查——
      // 工作记忆跨 run 持久时首请求即需瘦身）。失败不抛（优化非依赖）。
      await this.maybeCompact(state, input);
      state.rounds += 1;
      if (state.rounds > input.maxRounds) {
        this.emit({ type: "loop.run.finished", runId: state.runId, resolution: "roundLimit" });
        return { kind: "roundLimit", maxRounds: input.maxRounds };
      }
      state.turn += 1;
      this.emit({ type: "loop.turn.started", runId: state.runId, turn: state.turn });
      this.emit({ type: "loop.message.started", runId: state.runId, turn: state.turn });

      let response: Awaited<ReturnType<LoopStreamFn>>;
      // E-198：本轮流块完整收尾缓冲（块 end 凭证收集面——半截块无帧不进此）
      const blocks: LoopStreamBlock[] = [];
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
        const audit = await this.settleAbortedTurn(state, input, blocks, response.partialText);
        this.emit({ type: "loop.run.finished", runId: state.runId, resolution: "aborted" });
        return { kind: "aborted", ...(audit !== undefined ? { audit } : {}) };
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

  /** E-198 打断善后内核（§2.1 partial 保留）：安全块入账 + 截断标记 +
   *  不安全块丢弃。
   *  - 完整性唯一凭证 = 块 end（I1）：入参 blocks 只含已收 end 的块；
   *  - G1（duplex-truncation §3.3 text 行定稿）：未关账半截 text 经 partialText
   *    入账（与完成块同批，流序恒尾部）——文本无配对/签名约束全 provider
   *    安全，模型须记得被掐断的已播半句（P2）；partialText 缺席/空 = 无半截
   *    text，行为与 G1 前完全一致；partialText 只含未关账增量（adapter 保证
   *    不含已关账块，防重复入账）；
   *  - 半截 thinking/toolCall（无 end）无帧不入账（I2）；策略丢弃（完成但不可
   *    回传）：无签名 thinking（pi 判例③）与尾部悬挂 thinking（无后继内容块
   *    ——单独回传 = "reasoning without following item" 类 provider 拒绝，pi
   *    判例①同族；半截 text 作为后继内容块可合法承接签名 thinking）→ audit
   *    记录（I6）；
   *  - 完整 toolCall 未执行 → 合成中断 toolResult 配对（I3，pi 判例①同族）；
   *  - 截断标记（turn 级）永远落一枚：零安全块时也告知模型被掐（连续性），
   *    多次打断跨 run 各自累积不重复（T6）。 */
  private async settleAbortedTurn(
    state: RunState,
    input: LoopRunInput,
    blocks: readonly LoopStreamBlock[],
    partialText?: string,
  ): Promise<LoopAbortAudit | undefined> {
    const dropped: LoopAbortDroppedBlock[] = [];
    let pendingThinking: LoopThinking | undefined;
    let textParts: string[] = [];
    let keptCount = 0;
    const flushText = async (): Promise<void> => {
      if (textParts.length === 0) return;
      const assistant: LoopMessage = {
        role: "assistant",
        text: textParts.join("\n\n"),
        ...(pendingThinking !== undefined ? { thinking: pendingThinking } : {}),
      };
      pendingThinking = undefined;
      textParts = [];
      await this.recordMessage(state, input, assistant);
      keptCount += 1;
    };
    for (const block of blocks) {
      if (block.kind === "thinking") {
        await flushText(); // thinking 后置于文本时归属切分：先落前文（thinking 归属后续块）
        if (block.signature === undefined || block.signature === "") {
          dropped.push({ kind: "thinking", reason: "无签名不可回传（pi 判例③）", summary: block.text.slice(0, 80) });
          continue;
        }
        pendingThinking =
          pendingThinking === undefined
            ? { text: block.text, signature: block.signature }
            : { text: `${pendingThinking.text}\n${block.text}`, signature: pendingThinking.signature };
        continue;
      }
      if (block.kind === "text") {
        if (block.text !== "") textParts.push(block.text);
        continue;
      }
      // toolCall：完整收尾但未执行（打断在流式段——工具段不打断，§6.2）
      await flushText();
      const assistant: LoopMessage = {
        role: "assistant",
        ...(pendingThinking !== undefined ? { thinking: pendingThinking } : {}),
        toolCall: { id: block.id, name: block.name, args: block.args },
      };
      pendingThinking = undefined;
      await this.recordMessage(state, input, assistant);
      await this.recordMessage(state, input, {
        role: "toolResult",
        toolCallId: block.id,
        name: block.name,
        text: LOOP_INTERRUPTED_TOOL_RESULT_TEXT,
      });
      keptCount += 2;
    }
    // G1：未关账半截 text 追加到尾批文本（与完成块同批记录，流序恒尾部）
    if (partialText !== undefined && partialText !== "") textParts.push(partialText);
    await flushText();
    if (pendingThinking !== undefined) {
      dropped.push({
        kind: "thinking",
        reason: "尾部悬挂（无后继内容块——thinking 单独回传非法）",
        summary: pendingThinking.text.slice(0, 80),
      });
    }
    await this.recordMessage(state, input, { role: "user", text: LOOP_INTERRUPTED_MARKER_TEXT });
    return keptCount === 0 && dropped.length === 0 ? undefined : { keptMessages: keptCount, droppedBlocks: dropped };
  }
}
