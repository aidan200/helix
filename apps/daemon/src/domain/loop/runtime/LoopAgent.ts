/**
 * runtime/LoopAgent —— loop 域会话作用域运行时（helix-loop Phase 2 落位；
 * 设计 §2.4/§6——pi Agent 类形态的 helix 版，七面）。
 *
 * 组合 kernel 不重写循环（TR-223）：run 本体委派 LoopKernel；本件持跨 run 态
 * ——transcript（跨 run 单写者）+ InjectionQueue 双队列（A3）+ run 编排
 * （followUp 接管起新 run / continueRun P3 断点续跑，A4）。
 *
 * 语义锚（docs/temp/loop-interleaving-semantics.md 定稿，逐条对号）：
 * - G-A 单写者串行：同会话同时至多一个活跃 run（「Agent is already processing」
 *   同族守卫）；transcript 只经本件 appendMessage/kernel drain 注入变更；
 * - R2/R7.4：轮边界 drain 经 LoopRunInput.drainSteering 挂点注入 kernel
 *   （kernel 不持队列——分层：队列是跨 run 态归 runtime，轮内 poll 是 kernel
 *   挂点）；P0 撤销（skipInitialSteeringPoll）由本件闭包状态实现；
 * - R3.3：run 终态后 followUp 非空 → 起新 run（rounds 天然重置——新 run 新
 *   RunState）；接管链 fire-and-forget，start promise 只返本轮结果；
 * - R3.4：idle 时 steer 触发新 run（等价 followUp 路径；挂起 run 未终态时
 *   不触发——见 pausedPending）；
 * - R3.5 continueRun P3 序：末 assistant → drain steer 作新 run 输入 + 撤销
 *   P0 一次；steer 空 → drain followUp；皆空报错；末 user/toolResult →
 *   context-only 直接续跑；
 * - R4.9/G-G：abort 置位 signal 传播（kernel 收口 aborted），不清队列；reset
 *   是唯一清队列路径；
 * - R6.3 现役契约：paused 时 run promise settle = 写者释放（active 清空），
 *   resume 续跑由应用持 resumeWith 句柄；pausedPending 簿记挂起数——steer
 *   的 idle 触发判定排除挂起未终态的 run（R6.8：暂停期 steer 只入队）。
 *
 * 事件面（Phase 2 评估结论）：不扩 LoopEvent 15 型——waitForIdle 经内部
 * waiter 实现、isStreaming 同步轮询，均无需事件；agent 级 idle/processing
 * 状态事件面（原 Phase 5 LoopAgentEngineAdapter 事件映射——随主会话 loop
 * 通道退役删）已不在本内核消费面，未来消费需要时按 AgentEngineEvent
 * additive 评估（git 历史可考）。
 *
 * 依赖纪律：runtime → policy → kernel → contracts 单向（TR-223）；零 pi
 * import（AG-02）。
 */
import type {
  LoopCompactionInfo,
  LoopEventEmitter,
  LoopMessage,
  LoopMessageSink,
  LoopPauseDecision,
  LoopStreamFn,
  LoopToolCallContext,
  LoopToolSchema,
} from "../contracts";
import { synthesizeUnsettledToolResults } from "../contracts";
import { LoopKernel } from "../kernel";
import type { LoopRunCallbacks, LoopRunInput, LoopRunResult, RunState, ToolRegistry } from "../kernel";
import { InjectionQueue, injectionToMessage } from "./InjectionQueue";
import type { LoopInjection } from "./InjectionQueue";

/** run 生命周期阶段（prepareRun/onRunSettled 的 ctx 标注）。 */
export type LoopRunPhase = "start" | "followUp" | "continue";

/** 单 run 装配面（prepareRun 返回——应用在此刷新动态输入；缺省回落 deps 常量）。 */
export interface LoopRunOptions {
  readonly systemPrompt: string;
  readonly maxRounds: number;
  readonly tools?: readonly LoopToolSchema[];
  readonly beforeToolCallPause?: (context: LoopToolCallContext, signal?: AbortSignal) => Promise<LoopPauseDecision>;
  readonly callbacks?: LoopRunCallbacks;
  readonly promptSummary?: string;
}

/** run 装配钩子上下文。 */
export interface LoopRunPrepContext<TInjection extends LoopInjection = LoopInjection> {
  readonly phase: LoopRunPhase;
  /** 本 run 的输入注入（start/followUp/continue-P3 携带；context-only 续跑为
   *  undefined）。 */
  readonly injection: TInjection | undefined;
}

/** run 终态回调上下文（onRunSettled——含 paused：应用登记 resume 句柄面）。 */
export interface LoopRunSettledContext<TInjection extends LoopInjection = LoopInjection> {
  readonly phase: LoopRunPhase;
  readonly injection: TInjection | undefined;
}

export interface LoopAgentDeps<TInjection extends LoopInjection = LoopInjection> {
  readonly streamFn: LoopStreamFn;
  readonly registry: ToolRegistry;
  readonly emit: LoopEventEmitter;
  readonly newRunId?: () => string;
  /** 轮边界压缩步（policy 层装配注入——与 LoopKernelDeps.compactStep 同面；
   *  本件包装以同步 transcript：压缩整窗替换后接管最新窗口拷贝）。 */
  readonly compactStep?: (state: RunState, input: LoopRunInput) => Promise<void>;
  /** run 级缺省 systemPrompt（prepareRun 覆盖面）。 */
  readonly systemPrompt: string;
  /** run 级缺省工具轮上限（成本护栏——followUp 接管起新 run 天然重置 R7.3）。 */
  readonly maxRounds: number;
  /** Phase 3 D9（AgentConfig 级可选项）：批内并发执行上限（缺省 Infinity
   *  无上限——R1.5 随 pi；V3 实测后再议收紧）。 */
  readonly maxConcurrentTools?: number;
  /** LLM 工具面投影缺省（缺省 = registry.llmTools()）。 */
  readonly tools?: readonly LoopToolSchema[];
  /** steer 队列上限（缺省无上限——pi 同族；本批无消费者，防御位）。 */
  readonly steerLimit?: number;
  /** followUp 深度上限（D4 推荐口径，缺省 3）。 */
  readonly followUpLimit?: number;
  /** 新消息入账回调（transcript 与应用投影同源——assistant/toolResult/user
   *  与 steer 注入/start 输入全部经此）。 */
  readonly onNewMessage?: LoopMessageSink;
  /** LLM 请求边界的窗口配对防御（G-B 请求期合成面）：跨 run 挂起
   *  （paused 未 resume，如确认闸 pending 过期）的 toolCall 无 toolResult
   *  ——run 启动窗口装配时紧随其后合成占位（isError，文案注入；缺省
   *  “（本轮工具调用未收口）”）。run 内续轮不经此面（kernel I1 闭环）。 */
  readonly unsettledToolResultText?: (toolName: string) => string;
  /** 压缩完成回调（应用事实源整窗替换同步面——与 transcript 接管并行）。 */
  readonly onCompacted?: (info: LoopCompactionInfo) => Promise<void>;
  /** run 启动前装配钩子：应用刷新动态 systemPrompt/绑定该轮过程回调与挂闸
   *  闭包（每 run 独立调用——start/followUp 接管/continue 三相位）。 */
  readonly prepareRun?: (
    ctx: LoopRunPrepContext<TInjection>,
  ) => Promise<Partial<LoopRunOptions>> | Partial<LoopRunOptions>;
  /** run settle 回调（含 paused——应用登记确认闸/回执；接管链在回调后进行）。 */
  readonly onRunSettled?: (result: LoopRunResult, ctx: LoopRunSettledContext<TInjection>) => void | Promise<void>;
}

interface ActiveRun {
  readonly controller: AbortController;
  runId?: string;
}
export class LoopAgent<TInjection extends LoopInjection = LoopInjection> {
  private readonly deps: LoopAgentDeps<TInjection>;
  private readonly kernel: LoopKernel;
  private readonly queue: InjectionQueue<TInjection>;
  /** 跨 run transcript（单写者：appendMessage + kernel drain 注入；压缩整窗
   *  替换经 compactStep 包装接管拷贝）。 */
  private transcript: LoopMessage[] = [];
  private active: ActiveRun | null = null;
  /** 挂起未终态的 run 数（R6.3：paused settle 释放写者，但 resume 续跑未收口
   *  ——steer 的 R3.4 idle 触发判定排除该态，R6.8 暂停期只入队）。 */
  private pausedPending = 0;
  /** 挂起 run 的 abort 句柄簿记（R5.4 Phase 5：paused 态 abort 接线——
   *  写者已释放但 kernel 直持 signal；resumeWith 包装/abort 时除名）。 */
  private readonly pausedControllers = new Set<AbortController>();
  /** terminate 收口后 followUp 队列挂起（R5.4：不自动接管——待下一次显式
   *  run/continueRun 消费；beginRun 时解除，后续 settle 恢复正常接管链）。 */
  private followUpParked = false;
  private idleWaiters: Array<() => void> = [];

  constructor(deps: LoopAgentDeps<TInjection>) {
    this.deps = deps;
    this.kernel = new LoopKernel({
      streamFn: deps.streamFn,
      registry: deps.registry,
      emit: deps.emit,
      ...(deps.newRunId !== undefined ? { newRunId: deps.newRunId } : {}),
      compactStep: deps.compactStep !== undefined ? (state, input) => this.compactSync(state, input) : undefined,
    });
    this.queue = new InjectionQueue<TInjection>({
      ...(deps.steerLimit !== undefined ? { steerLimit: deps.steerLimit } : {}),
      ...(deps.followUpLimit !== undefined ? { followUpLimit: deps.followUpLimit } : {}),
    });
  }

  // ── 公开面 ──────────────────────────────────────────────

  /** 新 run（输入注入作首条 user 消息入账）。G-A：在飞 run 时抛错。 */
  start(input: string | TInjection): Promise<LoopRunResult> {
    if (this.active !== null) {
      throw new Error("LoopAgent is already processing（G-A 单写者：同会话同时至多一个活跃 run）");
    }
    const injection = (typeof input === "string" ? { text: input } : input) as TInjection;
    return this.beginRun(injection, "start", false);
  }

  /** steer 入队（G-C：任何窗口期只入队不干扰）；idle（无活跃 run 且无挂起
   *  run）时触发新 run——R3.4。返回入队结果（队列满拒——应用回执面）。 */
  steer(msg: TInjection): { ok: true; position: number } | { ok: false; reason: "queueFull"; limit: number } {
    const pushed = this.queue.pushSteer(msg);
    if (pushed.ok && this.active === null && this.pausedPending === 0) {
      const injection = this.queue.drainSteer();
      if (injection !== undefined) {
        // P0 撤销（R2.3 P2 守卫同族）：s 刚 drain 作新 run 输入——run 首轮
        // poll 点跳过一次，防同轮双投递（one-at-a-time）。
        this.beginRun(injection, "start", true).catch(() => undefined); // kernel promise 不 reject；防御 prepareRun 抛错
      }
    }
    return pushed;
  }

  /** followUp 入队（深度上限 D4；接管见 driveRun settle 处理——R3.3）。 */
  followUp(msg: TInjection): { ok: true; position: number } | { ok: false; reason: "queueFull"; limit: number } {
    return this.queue.pushFollowUp(msg);
  }

  /** abort：signal 置位传播（kernel 流式段收口 aborted——R4.6 顶部直收；
   *  工具段收尾后收口）；不清队列（R4.9）。幂等：无在飞 run 返回 false。
   *
   *  R5.4（Phase 5）paused 态接线：写者已释放（R6.3）但 kernel 直持 signal
   *  ——置位后挂闸解锁（PAUSE_ABORTED）、后台续链合成配对收口 aborted
   *  （事件面 run.interrupted → run.finished(aborted)）；resumeWith 惰性化
   *  由 kernel 承接（D5 幂等 aborted 零执行零新事件）。挂起簿记同步解除
   *  （resumeWith 无人再调——waitForIdle 不悬挂；后续调用幂等无副作用）。 */
  abort(reason?: string): boolean {
    if (this.active !== null) {
      this.active.controller.abort(reason ?? "aborted");
      return true;
    }
    if (this.pausedControllers.size === 0) return false;
    for (const controller of this.pausedControllers) controller.abort(reason ?? "aborted");
    this.pausedControllers.clear();
    this.pausedPending = 0;
    return true;
  }

  /** 挂起簿记观测面（R6.3/R6.8：paused 未终态——idle 通道判定用）。 */
  isPausedPending(): boolean {
    return this.pausedPending > 0;
  }

  /**
   * 断点续跑（A4；R3.5 P3 序）：
   * - 末消息 assistant（或空 transcript）：drain steer → 作新 run 输入且
   *   撤销 P0 一次（防同轮双投递）；steer 空 → drain followUp 作输入；
   *   皆空 → 报错；
   * - 末消息 user/toolResult：context-only 直接续跑（不加新消息；P0 正常
   *   poll——队列有 steer 则首轮注入）。
   */
  async continueRun(): Promise<LoopRunResult> {
    if (this.active !== null) {
      throw new Error("LoopAgent is already processing（G-A 单写者：同会话同时至多一个活跃 run）");
    }
    const last = this.transcript[this.transcript.length - 1];
    if (last === undefined || last.role === "assistant") {
      const injection = this.queue.drainSteer() ?? this.queue.drainFollowUp();
      if (injection === undefined) {
        throw new Error(
          last === undefined
            ? "不能从空 transcript 续跑：steer/followUp 队列皆空"
            : "不能从 assistant 收口续跑：steer/followUp 队列皆空",
        );
      }
      return this.beginRun(injection, "continue", true);
    }
    return this.beginRun(undefined, "continue", false);
  }

  /** 忙判定（观测面：活跃 run 在飞——含工具段；paused settle 后 false，
   *  R6.3 现役契约「paused 态非 streaming」）。 */
  isStreaming(): boolean {
    return this.active !== null;
  }

  /** 等待空闲：当前 run（含 followUp 接管链）与挂起 run 全部终态。 */
  async waitForIdle(): Promise<void> {
    if (this.isIdle()) return;
    await new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  /** 恢复回填面：清双队列（G-G 唯一清队列路径）+ 替换 transcript。 */
  reset(messages?: readonly LoopMessage[]): void {
    this.queue.clear();
    this.transcript = messages !== undefined ? [...messages] : [];
  }

  /** transcript 读面（快照拷贝——外泄引用不反向污染）。 */
  messages(): readonly LoopMessage[] {
    return [...this.transcript];
  }

  /** run 启动窗口装配（G-B 请求期防御：跨 run 挂起 toolCall 合成占位
   *  toolResult——紧随其后；run 内续轮不经此，kernel I1 闭环）。 */
  private runWindow(): readonly LoopMessage[] {
    return synthesizeUnsettledToolResults(this.transcript, this.deps.unsettledToolResultText ?? (() => "（本轮工具调用未收口）"));
  }

  /** 队列深度观测面（G-G 零吞验证锚）。 */
  pendingCounts(): { steer: number; followUp: number } {
    return this.queue.pendingCounts();
  }

  // ── 内部：run 编排 ──────────────────────────────────────

  private isIdle(): boolean {
    // followUpParked（R5.4）：terminate 挂起的 followUp 不代表在飞——空闲判定
    // 跳过该队列位（新 run beginRun 时解除挂起）。
    return (
      this.active === null &&
      this.pausedPending === 0 &&
      (this.followUpParked || this.queue.pendingCounts().followUp === 0)
    );
  }

  private notifyIdle(): void {
    if (!this.isIdle()) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /** beginRun：同步占位写者（防 await prepareRun 窗口重入）+ 异步驱动。
   *  followUpParked 解除（R5.4）：显式新 run 到来——挂起队列回归正常接管链。 */
  private beginRun(injection: TInjection | undefined, phase: LoopRunPhase, skipP0: boolean): Promise<LoopRunResult> {
    const active: ActiveRun = { controller: new AbortController() };
    this.active = active;
    this.followUpParked = false;
    return this.driveRun(active, injection, phase, skipP0);
  }

  private async driveRun(
    active: ActiveRun,
    injection: TInjection | undefined,
    phase: LoopRunPhase,
    skipP0: boolean,
  ): Promise<LoopRunResult> {
    try {
      // prepareRun 先于注入入账（应用在此补偿/快照组装——输入消息尚未入投影）
      const overrides = (await this.deps.prepareRun?.({ phase, injection })) ?? {};
      const options: LoopRunOptions = {
        systemPrompt: overrides.systemPrompt ?? this.deps.systemPrompt,
        maxRounds: overrides.maxRounds ?? this.deps.maxRounds,
        ...(overrides.tools !== undefined || this.deps.tools !== undefined
          ? { tools: overrides.tools ?? this.deps.tools }
          : {}),
        ...(overrides.beforeToolCallPause !== undefined ? { beforeToolCallPause: overrides.beforeToolCallPause } : {}),
        ...(overrides.callbacks !== undefined ? { callbacks: overrides.callbacks } : {}),
        ...(overrides.promptSummary !== undefined ? { promptSummary: overrides.promptSummary } : {}),
      };
      // 输入注入入账（start/followUp 接管/continue-P3：作新 run 首条 user）
      if (injection !== undefined) await this.appendMessage(injectionToMessage(injection));

      // drain 挂点（R2.2/R7.4：kernel 轮首 turn.started 后注入）；P0 撤销
      // （UC-19：continueRun P3 已 drain 作输入——run 首轮 poll 点跳过一次）
      let skipped = skipP0;
      const drainSteering = (): LoopMessage | undefined => {
        if (skipped) {
          skipped = false;
          return undefined;
        }
        const next = this.queue.drainSteer();
        return next !== undefined ? injectionToMessage(next) : undefined;
      };

      const handle = this.kernel.startRun({
        systemPrompt: options.systemPrompt,
        messages: this.runWindow(),
        tools: options.tools ?? this.deps.registry.llmTools(),
        maxRounds: options.maxRounds,
        ...(this.deps.maxConcurrentTools !== undefined ? { maxConcurrentTools: this.deps.maxConcurrentTools } : {}),
        signal: active.controller.signal,
        ...(options.beforeToolCallPause !== undefined ? { beforeToolCallPause: options.beforeToolCallPause } : {}),
        onNewMessage: (message) => this.appendMessage(message),
        ...(this.deps.onCompacted !== undefined ? { onCompacted: this.deps.onCompacted } : {}),
        ...(options.callbacks !== undefined ? { callbacks: options.callbacks } : {}),
        ...(options.promptSummary !== undefined ? { promptSummary: options.promptSummary } : {}),
        drainSteering,
        hasSteering: () => this.queue.pendingCounts().steer > 0,
      });
      if (this.active === active) active.runId = handle.runId;

      let result = await handle.promise;
      if (result.kind === "paused") {
        // R6.3/R6.8：挂起簿记 + resumeWith 包装（resume 调用即解除挂起计数——
        // 应用持包装句柄，续跑终态由应用消费）；abort 句柄同步登记（R5.4：
        // paused 态 abort 可达 kernel 直持 signal 面）。
        this.pausedPending += 1;
        this.pausedControllers.add(active.controller);
        const originalResume = result.resumeWith;
        const self = this;
        result = {
          ...result,
          resumeWith: async (decision) => {
            self.pausedControllers.delete(active.controller);
            self.pausedPending = Math.max(0, self.pausedPending - 1);
            return originalResume(decision);
          },
        };
      }
      this.active = null;
      try {
        await this.deps.onRunSettled?.(result, { phase, injection });
      } catch (err) {
        // 应用 settle 钩子异常不阻塞接管链（防御面——错误面由应用自管）
        this.deps.emit({ type: "loop.run.error", runId: handle.runId, message: `onRunSettled 钩子异常：${(err as Error).message}` });
      }
      // R3.3 followUp 接管：任何 settle 后 followUp 非空 → 起新 run（rounds
      // 天然重置——新 RunState；E-197 现役管家「任何收口都消费队列」等价口径）。
      // R5.4（Phase 5 收紧，CAND-551）：terminate 收口（结构化判别 cause==="terminate"）
      // 的 run 不被 followUp 复活——防火墙终态化（对齐 kernel 面 R5.4；pi 对照：
      // pi 全批 terminate 后 followUp 仍续轮，helix 有意偏离）。队列保留（G-G）
      // 供下一次显式 run/continueRun 消费（followUpParked：空闲判定跳过该位，
      // waitForIdle 不悬挂）；接管链 fire-and-forget——start promise 只返本轮结果。
      if (result.kind === "error" && result.cause === "terminate") {
        this.followUpParked = true;
        this.notifyIdle();
        return result;
      }
      const next = this.queue.drainFollowUp();
      if (next !== undefined) {
        this.beginRun(next, "followUp", false).catch(() => this.notifyIdle());
      } else {
        this.notifyIdle();
      }
      return result;
    } catch (err) {
      // prepareRun/入账抛错：释放写者再抛（不占死单写者面）
      if (this.active === active) this.active = null;
      this.notifyIdle();
      throw err;
    }
  }

  /** transcript 单写面：入 transcript + 应用投影回调（await 串行保序）。 */
  private async appendMessage(message: LoopMessage): Promise<void> {
    this.transcript.push(message);
    await this.deps.onNewMessage?.(message);
  }

  /** compactStep 包装：policy 压缩整窗替换 state.messages 后，transcript 接管
   *  最新窗口拷贝（拷贝而非引用——kernel 后续 recordMessage 与本件
   *  appendMessage 双侧独立追加，防同引用双写）。 */
  private async compactSync(state: RunState, input: LoopRunInput): Promise<void> {
    await this.deps.compactStep?.(state, input);
    this.transcript = [...state.messages];
  }
}
