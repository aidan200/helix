/**
 * kernel/ToolPhase —— loop 域工具段批执行器（helix-loop Phase 3 批工具改造；
 * 语义定稿 docs/temp/loop-interleaving-semantics.md R1/R4/R5/R6 逐条对号）。
 *
 * 批执行序（R1，G-D 事件完成序 / 入账源序解耦）：
 * - preflight 逐枚依源序（emit tool.started → abort 检查 → gate 判定 → 未知工具
 *   检查）；挂闸枚不阻塞其余枚 preflight（R6.2——有意偏离 pi 的队头阻塞）；
 * - 放行枚随各自 preflight 通过即起跑（UC-09/UC-12 场景：后续枚 preflight 期
 *   abort/terminate 时已启动枚真实结果照记）；并发无上限（D9 maxConcurrentTools
 *   可选 cap，缺省 Infinity）；
 * - loop.tool.finished 完成序发射（immediate 终结枚 preflight 期就地发射，R1.6）；
 *   toolResult 消息批收口后按 assistant 源序统一入账（R1.7——provider 位置配对
 *   安全）；sequential 批（R1.2：批内任一枚注册 sequential → 全批 sequential）
 *   严格逐枚：执行完成→入账→下一枚（UC-02）。
 *
 * 暂停闸 × 批（R6）：
 * - 首闸即 settle（D1 裁决）：批内首枚挂闸即发 loop.run.paused + run promise
 *   settle paused，批后续（其余枚 preflight/执行/收口）在后台续链——事件流与
 *   promise 状态解耦，在飞兄弟枚事件照常流出；挂闸时 assistant 已入账（工作
 *   记忆可见——现役契约）；后续挂闸由续链递次交出（递归 paused 同构）；
 * - approveWith 只改本枚（R6.4）；reject = per-tool 拒绝回灌批续（R6.5）；
 *   resolve = 本枚外部结果 + 在飞兄弟照常收尾 + run 终态 resolved（R6.6/D10）；
 * - gate 增可选 signal（R6.7 additive——阻塞等待中的闸可被打断）。
 *
 * abort 收序（R4）：
 * - signal 传播进工具 ctx（R4.2——contracts/tool.ts additive 位，本件填充）；
 *   批收口等全部在飞枚 settle（延迟上限 = 最慢不响应 signal 的工具）；
 * - 未启动枚（preflight 期 abort / 起跑查 / cap 队列）合成中断配对（R4.3，
 *   G-B 零孤儿——pi 的瞬态孤儿不可学 R4.5）；
 * - 批 settle 后直收 aborted（R4.6/D8——不补打 streamFn），标记 + audit 批推广
 *   （R4.7/D7：keptMessages 计真实+合成配对枚）；暂停期 abort 后 resumeWith
 *   惰性化（R4.8/D5：幂等 aborted、零执行零新事件）。
 *
 * 批级 early-termination（R5）：
 * - dispatched terminate 是普通回灌结果参与 AND 判定（R5.1：every 而非 some）；
 *   全批 terminate → 防火墙收口 error（R5.2，零续跑不 poll 队列 R5.4）；
 * - gate-preflight terminate 即决防火墙（R5.3/D2：不等批 AND 判定，批内已决
 *   结果保留、未启动枚合成配对——I1 优先；批内无任何已决结果时保持单工具
 *   时代零入账判例）；
 * - length 截断批全 fail 零执行（R5.5——LOOP_TRUNCATED_TOOL_RESULT_TEXT，
 *   terminate 恒 false 循环继续，模型可重发）。
 *
 * 依赖纪律：本件只 import contracts（不 import policy）。
 */
import type {
  LoopContentBlock,
  LoopEvent,
  LoopEventEmitter,
  LoopMessage,
  LoopResumeDecision,
  LoopToolCallContext,
} from "../contracts";
import { loopToolArgsSummary } from "../contracts/event";
import {
  LOOP_INTERRUPTED_MARKER_TEXT,
  LOOP_INTERRUPTED_TOOL_RESULT_TEXT,
  LOOP_TRUNCATED_TOOL_RESULT_TEXT,
} from "../contracts/markers";
import type { ToolRegistry } from "./ToolRegistry";
import { abortReasonOf, recordMessage, type LoopRunInput, type LoopRunResult, type RunState } from "./RunState";

/** 工具段继续信号（非终态——循环进下一轮）。 */
export const CONTINUE = Symbol("loop-continue");
export type ToolPhaseResult = LoopRunResult | typeof CONTINUE;

type ToolCallBlock = LoopContentBlock & { type: "toolCall" };

/** 批内单枚终态结果（事件/入账分离——G-D）。terminate 位仅 dispatched 路径置真（R5.1 AND 判定）。 */
interface BatchOutcome {
  readonly text: string;
  readonly isError: boolean;
  readonly summary?: string;
  readonly terminate: boolean;
}

/** 批内单枚状态机：pending → released/suspended → settled。 */
interface BatchEntry {
  readonly ctx: LoopToolCallContext;
  status: "pending" | "released" | "suspended" | "settled";
  outcome?: BatchOutcome;
  /** R5.3 gate 前置拒 terminate 的配对文案（批内有已决结果时才物化入账——零入账判例保持）。 */
  gateTerminateReason?: string;
  /** sequential 批完成即入账标记（closeout 不重复入账）。 */
  accounted?: boolean;
}

/** 暂停期 abort 的挂闸解锁记号（非 LoopResumeDecision 成员——内部哨兵）。 */
const PAUSE_ABORTED = Symbol("loop-pause-aborted");

/** 挂闸挂起（resumeWith 决策面——首闸由 run() 交出，后续挂闸由续链递次交出）。 */
interface Suspension {
  readonly entry: BatchEntry;
  pauseToken?: string;
  handed: boolean;
  resolved: boolean;
  resolve: (decision: LoopResumeDecision | typeof PAUSE_ABORTED) => void;
  decision: Promise<LoopResumeDecision | typeof PAUSE_ABORTED>;
}

/** 批执行上下文（单批生命周期内可变态集中）。 */
interface BatchRun {
  readonly state: RunState;
  readonly input: LoopRunInput;
  readonly entries: BatchEntry[];
  readonly assistant: LoopMessage;
  readonly resume: () => Promise<LoopRunResult>;
  readonly suspensions: Suspension[];
  readonly sequential: boolean;
  /** 在飞执行 promise 集（cap 泵链续入——awaitLaunches 快照轮询）。 */
  readonly launches: Set<Promise<void>>;
  readonly capQueue: BatchEntry[];
  inFlight: number;
  assistantRecorded: boolean;
  firewallReason?: string;
  resolvedFlag: boolean;
  /** 暂停链交出面：当前 resumeWith 等待的 deferred resolve（后台续链终态/递归 paused 经此交出）。 */
  chainResolve?: (result: LoopRunResult) => void;
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** signal 置位判定（独立函数——防 TS 控制流把 await 前的 abort 收窄带过
 *  await 点：gate/工具执行 await 期间 signal 可被置位，必须现场重读）。 */
function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** 工具段批执行器（pauseSeq 引擎实例级——跨 run 递增，pauseToken 唯一性）。 */
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

  /** 工具执行段入口（Phase 3 批语义）。
   *  返回：CONTINUE（批收口续轮）/ LoopRunResult 终态（paused 首闸即 settle /
   *  error 防火墙 / aborted 批打断 / resolved）。 */
  async run(
    state: RunState,
    input: LoopRunInput,
    toolCalls: readonly ToolCallBlock[],
    assistant: LoopMessage,
    resume: () => Promise<LoopRunResult>,
    opts: { readonly truncated?: boolean } = {},
  ): Promise<ToolPhaseResult> {
    const entries: BatchEntry[] = toolCalls.map((block) => ({
      ctx: { runId: state.runId, toolCallId: block.id, toolName: block.name, args: block.args },
      status: "pending" as const,
    }));
    if (opts.truncated === true) return this.failTruncatedBatch(state, input, entries, assistant);
    const sequential = entries.some((e) => this.registry.registration(e.ctx.toolName)?.executionMode === "sequential");
    const batch: BatchRun = {
      state,
      input,
      entries,
      assistant,
      resume,
      suspensions: [],
      sequential,
      launches: new Set(),
      capQueue: [],
      inFlight: 0,
      assistantRecorded: false,
      resolvedFlag: false,
    };
    // R4.8/R6.7：暂停期 abort 解锁面——阻塞等待中的挂闸可被打断
    const onAbort = (): void => {
      for (const s of batch.suspensions) {
        if (s.resolved) continue;
        s.resolved = true;
        s.resolve(PAUSE_ABORTED);
      }
    };
    if (input.signal !== undefined) input.signal.addEventListener("abort", onAbort);
    const firstPause = await this.preflight(batch, 0);
    if (firstPause !== undefined) {
      // R6.3/D1 首闸即 settle：交出 paused，批后续在后台续链（事件流与 promise 状态解耦）
      const paused = this.makePaused(batch, batch.suspensions[0]!);
      void this.backgroundDrive(batch, onAbort, firstPause + 1);
      return paused;
    }
    try {
      return await this.driveRest(batch, entries.length);
    } finally {
      if (input.signal !== undefined) input.signal.removeEventListener("abort", onAbort);
    }
  }

  /** R5.5 length 截断批全 fail：逐枚 started/finished（截断文案 error）零执行 → 入账 → 续轮。 */
  private async failTruncatedBatch(
    state: RunState,
    input: LoopRunInput,
    entries: BatchEntry[],
    assistant: LoopMessage,
  ): Promise<ToolPhaseResult> {
    for (const entry of entries) {
      this.emitToolStarted(state, input, entry.ctx);
      this.settle(state, input, entry, { text: LOOP_TRUNCATED_TOOL_RESULT_TEXT, isError: true, terminate: false });
    }
    await this.accountBatch(state, input, entries, assistant);
    this.emitTurnFinished(state, entries);
    return CONTINUE;
  }

  /** 首闸后的后台续链（run promise 已 settle paused——续链结果经 chainResolve 交出）。 */
  private async backgroundDrive(batch: BatchRun, onAbort: () => void, preflightFrom: number): Promise<void> {
    try {
      const result = await this.driveRest(batch, preflightFrom);
      if (result === CONTINUE) {
        // 批收口续轮：回主循环（递归 driveLoop）——续跑终态（含后续轮再挂闸的
        // 递归 paused 同构）交 resumeWith 链
        const continued = await batch.resume();
        batch.chainResolve?.(continued);
      } else {
        // 续链终态交出（resumeWith 在场时其 promise 经 chainResolve 收口；无人等待即落空）
        batch.chainResolve?.(result);
      }
    } catch (err) {
      // 防御：后台续链异常不悬挂（事件面报错收口——正常路径不达）
      this.emit({ type: "loop.run.error", runId: batch.state.runId, message: `批后台续链异常：${(err as Error).message}` });
      this.emit({ type: "loop.run.finished", runId: batch.state.runId, resolution: "error" });
    } finally {
      if (batch.input.signal !== undefined) batch.input.signal.removeEventListener("abort", onAbort);
    }
  }

  /** 批执行主链：preflight 续走 → settle → closeout（无挂闸时由 run() 直收）。 */
  private async driveRest(batch: BatchRun, preflightFrom: number): Promise<ToolPhaseResult> {
    await this.preflight(batch, preflightFrom);
    await this.settlePhase(batch);
    return this.closeout(batch);
  }

  // ── Phase 1：preflight（逐枚源序串行） ──────────────────────────

  /** 返回首个挂闸的 index（首闸即 settle 面）；undefined = 全批 preflight 完成。 */
  private async preflight(batch: BatchRun, start: number): Promise<number | undefined> {
    const { state, input } = batch;
    for (let i = start; i < batch.entries.length; i++) {
      const entry = batch.entries[i]!;
      this.emitToolStarted(state, input, entry.ctx);
      // R1.8：abort 已置位 → immediate 合成中断（不进并发段；G-B 配对）
      if (signalAborted(input.signal)) {
        this.settle(state, input, entry, this.interruptedOutcome());
        continue;
      }
      // R5.3 防火墙标记后不再过闸（run 已注定 error 收口——挂闸/前置校验无意义面）
      const gate = batch.firewallReason === undefined ? input.beforeToolCallPause : undefined;
      if (gate !== undefined) {
        const decision = await gate(entry.ctx, input.signal); // R6.7 signal additive
        // gate await 期 abort 置位 → 本枚合成配对（R4.3——UC-09 C 未启动）
        if (signalAborted(input.signal)) {
          this.settle(state, input, entry, this.interruptedOutcome());
          continue;
        }
        if (decision.pause) {
          entry.status = "suspended";
          batch.suspensions.push(this.createSuspension(entry));
          if (batch.suspensions.length === 1) {
            // R6.3 首闸即 settle（D1 裁决）：挂闸时 assistant 已入账（工作记忆可见——现役契约）；
            // 本闸 paused 由 run() 直接交出（handed——续链不重复交出）
            await this.recordAssistantOnce(batch);
            const first = batch.suspensions[0]!;
            first.pauseToken = this.nextPauseToken(state);
            first.handed = true;
            this.emitPaused(state, first);
            return i;
          }
          continue; // R6.2 后续挂闸不阻塞其余枚 preflight；paused 面由续链递次交出（递归同构）
        }
        const outcome = decision.outcome;
        if (outcome !== undefined && outcome.kind === "terminate") {
          // R5.3/D2 即决防火墙：不等批 AND 判定；批内照常继续（已启动枚真实结果保留）
          entry.status = "settled";
          entry.gateTerminateReason = outcome.reason;
          batch.firewallReason ??= outcome.reason;
          continue;
        }
        if (outcome !== undefined) {
          // R1.8 挂钩前置校验产物：immediate 终结枚（preflight 期就地 finished）
          this.settle(state, input, entry, {
            text: outcome.text,
            isError: outcome.isError === true,
            ...(outcome.summary !== undefined ? { summary: outcome.summary } : {}),
            terminate: false,
          });
          continue;
        }
      }
      if (this.registry.registration(entry.ctx.toolName) === undefined) {
        // R1.8 未知工具：immediate error 回灌（与迁移前文案等价）
        this.settle(state, input, entry, { text: `未知工具 ${entry.ctx.toolName}`, isError: true, terminate: false });
        continue;
      }
      entry.status = "released";
      if (!batch.sequential) this.scheduleLaunch(batch, entry);
    }
    return undefined;
  }

  // ── Phase 2：settle（并发等待 / sequential 逐枚 / 挂闸递次处理） ──

  private async settlePhase(batch: BatchRun): Promise<void> {
    if (batch.sequential) {
      // R1.2 全批 sequential：严格逐枚（执行完成→入账→下一枚，UC-02）；挂闸枚
      // 占位等待（天然冻结 R6.2——其后枚不启动）
      for (const entry of batch.entries) {
        if (entry.status === "released") {
          await this.executeEntry(batch, entry);
          await this.accountEntry(batch, entry);
        } else if (entry.status === "suspended") {
          const suspension = batch.suspensions.find((s) => s.entry === entry);
          if (suspension !== undefined) await this.processSuspension(batch, suspension);
        }
      }
      return;
    }
    // parallel：在飞全 settle（含 cap 泵链）→ 挂闸依源序递次处理
    while (batch.launches.size > 0) {
      await Promise.all([...batch.launches]);
    }
    for (const suspension of [...batch.suspensions]) {
      await this.processSuspension(batch, suspension);
      if (batch.resolvedFlag) break;
    }
  }

  /** 单挂闸处理：递归交出（非首闸）→ 决策消费（approve/approveWith/reject/resolve/abort）。 */
  private async processSuspension(batch: BatchRun, suspension: Suspension): Promise<void> {
    const { state, input } = batch;
    if (!suspension.handed) {
      // R6.3 递归同构：续链到达本挂闸 → 交出 paused（首闸已在 preflight 交出）
      await this.recordAssistantOnce(batch);
      suspension.pauseToken = this.nextPauseToken(state);
      this.emitPaused(state, suspension);
      batch.chainResolve?.(this.makePaused(batch, suspension));
      suspension.handed = true;
    }
    const decision = await suspension.decision;
    if (decision === PAUSE_ABORTED) {
      // R4.8：暂停期 abort → 挂闸枚补合成配对（收口 aborted 由 closeout 统一）
      this.settle(state, input, suspension.entry, this.interruptedOutcome());
      return;
    }
    if (decision.kind === "resolve") {
      // R6.6/D10：本枚外部结果 + 其余挂起枚合成配对（无外部裁决面）+ 终态 resolved
      this.settle(state, input, suspension.entry, {
        text: decision.text,
        isError: decision.isError === true,
        terminate: false,
      });
      batch.resolvedFlag = true;
      for (const other of batch.suspensions) {
        if (other === suspension || other.entry.status !== "suspended") continue;
        other.resolved = true;
        this.settle(state, input, other.entry, this.interruptedOutcome());
      }
      return;
    }
    if (decision.kind === "reject") {
      // R6.5：per-tool 拒绝回灌（isError）批续——模型可见拒绝文案自纠
      this.settle(state, input, suspension.entry, { text: decision.text, isError: true, terminate: false });
      return;
    }
    // approve / approveWith（R6.4：改参只作用本枚——其余枚参数在各自 preflight 定格）
    await this.executeEntry(batch, suspension.entry, decision.kind === "approveWith" ? decision.args : undefined);
  }

  /** 枚执行（起跑查 + ctx 装配 + dispatch 归一 + finished 完成序发射）。 */
  private async executeEntry(batch: BatchRun, entry: BatchEntry, argsOverride?: Record<string, unknown>): Promise<void> {
    const execution = this.executeEntryInner(batch, entry, argsOverride);
    batch.launches.add(execution);
    try {
      await execution;
    } finally {
      batch.launches.delete(execution);
    }
  }

  private async executeEntryInner(batch: BatchRun, entry: BatchEntry, argsOverride?: Record<string, unknown>): Promise<void> {
    const { state, input } = batch;
    batch.inFlight += 1;
    try {
      // 起跑查（R4.3）：未启动枚遇 abort → 合成配对不执行（pi 判例 closure 起跑查同构）
      if (signalAborted(input.signal)) {
        this.settle(state, input, entry, this.interruptedOutcome());
        return;
      }
      const ctx: LoopToolCallContext = {
        ...entry.ctx,
        ...(argsOverride !== undefined ? { args: argsOverride } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}), // R4.2 signal 传播
        onUpdate: (partial: string): void => {
          // R1.10 onUpdate → tool.progress（单枚内 FIFO；跨枚交错——D6 集合等价断言面）
          this.emit({ type: "loop.tool.progress", runId: state.runId, toolCallId: entry.ctx.toolCallId, partial });
        },
      };
      const dispatched = await this.registry.dispatch(ctx.toolName, ctx.args, ctx);
      if (!dispatched.ok) {
        this.settle(state, input, entry, { text: `未知工具 ${ctx.toolName}`, isError: true, terminate: false });
        return;
      }
      const outcome = dispatched.outcome;
      if (outcome.kind === "terminate") {
        // R5.1/R5.2：dispatched terminate 是普通回灌结果（reason 文案 isError 照记）
        // + 参与 AND 判定（全批 terminate 才防火墙收口）
        this.settle(state, input, entry, { text: outcome.reason, isError: true, terminate: true });
        return;
      }
      this.settle(state, input, entry, {
        text: outcome.text,
        isError: outcome.isError === true,
        ...(outcome.summary !== undefined ? { summary: outcome.summary } : {}),
        terminate: false,
      });
    } finally {
      batch.inFlight -= 1;
      // D9 cap 泵：腾出的并发槽按源序续起（capQueue 源序入队）
      const next = batch.capQueue.shift();
      if (next !== undefined) void this.executeEntry(batch, next);
    }
  }

  /** D9 并发上限调度：在 cap 内即起跑，超出排队（源序）。 */
  private scheduleLaunch(batch: BatchRun, entry: BatchEntry): void {
    const cap = batch.input.maxConcurrentTools ?? Number.POSITIVE_INFINITY;
    if (batch.inFlight < cap) void this.executeEntry(batch, entry);
    else batch.capQueue.push(entry);
  }

  // ── Phase 3：closeout（源序入账 + 批判定收口） ──────────────────

  private async closeout(batch: BatchRun): Promise<ToolPhaseResult> {
    const { state, input } = batch;
    const aborted = signalAborted(input.signal);
    // R5.3 零入账判例保持：gate 前置拒防火墙且批内无任何已决结果（单工具无痕）
    // ——有已决结果则 I1 优先（assistant 入账 + 全配对，UC-12）
    const zeroAccountFirewall = batch.firewallReason !== undefined && !batch.entries.some((e) => e.outcome !== undefined);
    let keptMessages = 0;
    if (!zeroAccountFirewall) {
      // 入账（R1.7 源序）：assistant（首次）→ toolResult 依源序（gate 前置拒枚
      // 此时物化配对文案）
      await this.recordAssistantOnce(batch);
      keptMessages += 1;
      for (const entry of batch.entries) {
        if (entry.accounted === true) {
          keptMessages += 1; // sequential 已逐枚入账（audit 计数仍计入）
          continue;
        }
        const outcome = entry.outcome ?? this.gateTerminateOutcome(entry) ?? this.interruptedOutcome();
        entry.outcome = outcome;
        await this.recordToolResult(state, input, entry, outcome);
        keptMessages += 1;
      }
      if (aborted) {
        // R4.7 批打断标记一枚（D7 文案：未执行枚是配对入账而非丢弃）
        await recordMessage(state, input, { role: "user", text: LOOP_INTERRUPTED_MARKER_TEXT });
      }
    }
    this.emitTurnFinished(state, batch.entries);
    if (aborted) {
      // R4.6/D8 批 settle 后直收 aborted（不补打 streamFn）；audit 批推广（R4.7）
      this.emit({ type: "loop.run.interrupted", runId: state.runId, reason: abortReasonOf(input.signal) });
      this.emit({ type: "loop.run.finished", runId: state.runId, resolution: "aborted" });
      const audit = keptMessages === 0 ? undefined : { keptMessages, droppedBlocks: [] };
      return { kind: "aborted", ...(audit !== undefined ? { audit } : {}) };
    }
    if (batch.firewallReason !== undefined) {
      // R5.3/R5.4：防火墙终态化（零续跑不 poll 队列——队列保留供下次显式 run）
      return this.terminateRun(state, batch.firewallReason);
    }
    if (batch.resolvedFlag) {
      // R6.6：resolve 收口（不续轮不 poll 队列）
      this.emit({ type: "loop.run.finished", runId: state.runId, resolution: "resolved" });
      return { kind: "resolved" };
    }
    // R5.1 AND 判定：批内全部结果 terminate === true（every——单枚 terminate 不停批）
    if (batch.entries.length > 0 && batch.entries.every((e) => e.outcome?.terminate === true)) {
      const reason = batch.entries.find((e) => e.outcome?.terminate === true)?.outcome?.text ?? batch.firewallReason ?? "terminated";
      return this.terminateRun(state, reason);
    }
    return CONTINUE;
  }

  /** 防火墙前置拒直出回执（R5.3——run 错误收口；cause:"terminate" 结构化判别
   *  ——R5.4 Phase 5：LoopAgent 收口段据此不接管 followUp）。 */
  private terminateRun(state: RunState, reason: string): LoopRunResult {
    this.emit({ type: "loop.run.error", runId: state.runId, message: reason });
    this.emit({ type: "loop.run.finished", runId: state.runId, resolution: "error" });
    return { kind: "error", message: reason, cause: "terminate" };
  }

  /** 批入账（truncated 路径共用——assistant + 全配对源序）。 */
  private async accountBatch(
    state: RunState,
    input: LoopRunInput,
    entries: BatchEntry[],
    assistant: LoopMessage,
  ): Promise<void> {
    await recordMessage(state, input, assistant);
    for (const entry of entries) {
      const outcome = entry.outcome ?? this.interruptedOutcome();
      entry.outcome = outcome;
      await this.recordToolResult(state, input, entry, outcome);
    }
  }

  /** sequential 批逐枚入账（完成即入账——下一枚启动前，UC-02）。 */
  private async accountEntry(batch: BatchRun, entry: BatchEntry): Promise<void> {
    if (entry.outcome === undefined) return;
    await this.recordAssistantOnce(batch);
    await this.recordToolResult(batch.state, batch.input, entry, entry.outcome);
    entry.accounted = true;
  }

  private async recordAssistantOnce(batch: BatchRun): Promise<void> {
    if (batch.assistantRecorded) return;
    await recordMessage(batch.state, batch.input, batch.assistant);
    batch.assistantRecorded = true;
  }

  private async recordToolResult(
    state: RunState,
    input: LoopRunInput,
    entry: BatchEntry,
    outcome: BatchOutcome,
  ): Promise<void> {
    await recordMessage(state, input, {
      role: "toolResult",
      toolCallId: entry.ctx.toolCallId,
      name: entry.ctx.toolName,
      text: outcome.text,
    });
  }

  private gateTerminateOutcome(entry: BatchEntry): BatchOutcome | undefined {
    if (entry.gateTerminateReason === undefined) return undefined;
    return { text: entry.gateTerminateReason, isError: true, terminate: false };
  }

  private interruptedOutcome(): BatchOutcome {
    return { text: LOOP_INTERRUPTED_TOOL_RESULT_TEXT, isError: true, terminate: false };
  }

  // ── 暂停原语 ────────────────────────────────────────────

  private createSuspension(entry: BatchEntry): Suspension {
    const deferred = createDeferred<LoopResumeDecision | typeof PAUSE_ABORTED>();
    return {
      entry,
      handed: false,
      resolved: false,
      resolve: deferred.resolve,
      decision: deferred.promise,
    };
  }

  private nextPauseToken(state: RunState): string {
    this.pauseSeq += 1;
    return `${state.runId}-pause-${this.pauseSeq}`;
  }

  private emitPaused(state: RunState, suspension: Suspension): void {
    const { ctx } = suspension.entry;
    this.emit({
      type: "loop.run.paused",
      runId: state.runId,
      pauseToken: suspension.pauseToken ?? "",
      toolCallId: ctx.toolCallId,
      toolName: ctx.toolName,
      argsSummary: loopToolArgsSummary(ctx.args),
    });
  }

  /** paused 结果 + resumeWith（惰性化 + 链交出面推进）。 */
  private makePaused(batch: BatchRun, suspension: Suspension): LoopRunResult {
    const { ctx } = suspension.entry;
    const resumeWith = async (decision: LoopResumeDecision): Promise<LoopRunResult> => {
      // R4.8/D5 惰性化：abort 后任何决策幂等返回 aborted——零执行零新事件
      if (signalAborted(batch.input.signal) || suspension.resolved) return { kind: "aborted" }; // 双重 resume/已消费防御
      this.emit({
        type: "loop.run.resumed",
        runId: batch.state.runId,
        pauseToken: suspension.pauseToken ?? "",
        decision: decision.kind,
      });
      suspension.resolved = true;
      const next = createDeferred<LoopRunResult>();
      batch.chainResolve = next.resolve;
      suspension.resolve(decision);
      return next.promise;
    };
    return {
      kind: "paused",
      pauseToken: suspension.pauseToken ?? "",
      toolCall: { id: ctx.toolCallId, name: ctx.toolName, args: ctx.args },
      resumeWith,
    };
  }

  // ── 事件面 ──────────────────────────────────────────────

  private emitToolStarted(state: RunState, input: LoopRunInput, ctx: LoopToolCallContext): void {
    const argsSummary = loopToolArgsSummary(ctx.args);
    this.emit({
      type: "loop.tool.started",
      runId: state.runId,
      toolCallId: ctx.toolCallId,
      toolName: ctx.toolName,
      argsSummary,
      args: ctx.args, // Phase 5 additive：全对象（AgentEnginePort 投影源）
    });
    input.callbacks?.onToolStart?.(ctx.toolName, argsSummary);
  }

  /** 枚 settle：终态定格 + loop.tool.finished（完成序发射——G-D）+ onToolEnd。
   *  Phase 5 additive：result 载荷携全文（AgentEnginePort 投影源）。 */
  private settle(state: RunState, input: LoopRunInput, entry: BatchEntry, outcome: BatchOutcome): void {
    entry.status = "settled";
    entry.outcome = outcome;
    const base = outcome.summary ?? outcome.text;
    const resultSummary = base.length <= 200 ? base : `${base.slice(0, 200)}…`;
    this.emit({
      type: "loop.tool.finished",
      runId: state.runId,
      toolCallId: entry.ctx.toolCallId,
      toolName: entry.ctx.toolName,
      isError: outcome.isError,
      resultSummary,
      result: base,
    });
    input.callbacks?.onToolEnd?.(entry.ctx.toolName, resultSummary);
  }

  private emitTurnFinished(state: RunState, entries: readonly BatchEntry[]): void {
    this.emit({
      type: "loop.turn.finished",
      runId: state.runId,
      turn: state.turn,
      stopReason: "toolUse",
      tools: entries.map((e) => e.ctx.toolName),
    });
  }
}
