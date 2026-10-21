/**
 * StewardLifecycle —— 管家生命周期域（体量门 P4：自 StewardService 迁出）。
 *
 * 职责（run 从驱动到收口的全过程 + 兜底巡检 + 对话记忆读写）：
 * - run 执行链：driveAsk 同步占位 → 装配（快照/在途提案/systemPrompt/引擎
 *   懒构造）→ 引擎事件投影（KV 入账/挂闸暂停/压缩）→ 收口推导与回执、
 *   队列驱动；
 * - 兜底巡检：run 看门狗（挂死流恢复）、确认卡可达性提醒、确认闸 TTL 作废
 *   ——启停定时器面（start/stop → startReliabilityTimers）与单拍入口
 *   reliabilityTick（测试注入时钟，生产 interval 驱动）；
 * - 对话记忆读写：history 回放读面与新对话闸（清 KV + 弃引擎 + 在途/排队
 *   ask 收口）。
 *
 * 状态与共享编排态由 StewardCore 单点持有——本类只持有 `core` 引用，方法体
 * 自 StewardService 逐段搬运（仅 `this.<状态>` → `this.core.<状态>` 改写）。
 *
 * 纪律来源：E-289（管家执行轮子域 StewardRun/AskQueue 单飞占位与锚复位）/
 * TR-240（确认链路状态面：终局收敛经 ProposalLedger）/ E-240（队列行为等价
 * 不变量：FIFO 不丢/满拒新/收口后自动下一轮）。域界：本域管 run 生命周期与
 * 定时巡检，出口帧一律经播报编排域（StewardOutlet），确认闸门禁判定在
 * 分诊路由域（StewardRouting）——两域经 core 引用协作。
 */
import type {
  StewardAskResultPayload,
  StewardHistoryRecord,
} from "@helix/protocol";
import type {
  PendingAction,
} from "../../domain/steward/confirmation/ProposalLedger";
import { pendingKeyOf } from "../../domain/steward/confirmation/ProposalLedger";
import { judgeRunWatchdog } from "../../domain/steward/run/RunWatchdog";
import type { AgentEngineEvent, AgentEnginePort } from "../ports/outbound/AgentEnginePort";
import { stewardBlocksText } from "./stewardBlocks";
import { STEWARD_COMPACTION_SUMMARY_PROMPT, assembleStewardSystemPrompt, buildPendingProposalsSection } from "./stewardPrompts";
import { capChars, capToolResultText, displayTitleOf } from "./stewardProjections";
import { buildContextSnapshot } from "./stewardSnapshots";
import {
  GATED_TOOLS,
  STEWARD_COMPACTION_KEEP_RECENT,
  STEWARD_COMPACTION_THRESHOLD_TOKENS,
  STEWARD_CONFIRM_TIMEOUT_DETAIL,
  SNAPSHOT_RECENT_SESSIONS,
} from "./stewardConstants";
import type { StewardAskItem } from "./stewardServiceTypes";
import type { StewardCore } from "./StewardCore";

export class StewardLifecycle {
  private readonly core: StewardCore;

  constructor(core: StewardCore) {
    this.core = core;
  }

  /** run 驱动（原 prepareAskRun + agent.start 合体）：每 run 动态 systemPrompt
   *  组装（感知快照 + 记忆召回——setSystemPrompt 运行期变异面）+ B4a 补偿
   *  （队列接管轮）+ 事件收口挂载。   *
   *  事故热修批④（队列并发锁）：runActive 提前到本同步段置位——原实现置位
   *  在 await 装配段之后，ask 检查面在「run 收口（runActive=false）→ driveAsk
   *  装配 await → runActive=true」的间隙里看到假空闲态，相邻 ask 并发直驱双
   *  run（2026-10-07 事故 26ms 双 run「Agent is already processing a prompt」）。
   *  同步占位 + finishRun 幂等守卫共同封死 drain 与新 ask 竞态（任一时刻至
   *  多一个 run 在途；E-240 队列行为断言面不变）。装配异常兑底：占位后若
   *  装配失败，释放占位并收口 error 回执（防 runActive 永真死锁队列）。 */
  driveAsk(item: StewardAskItem): Promise<StewardAskResultPayload> {
    this.core.run.occupy(); // 单飞同步占位（零 await 间隙——ask 检查面立即可见）
    this.core.runEpoch += 1; // run 代际号（评审 low #2：异步判定回来时认「是不是同一个 run」）
    const run = this.assembleAndRun(item);
    run.catch(() => undefined); // 兕底异常不经本链传播（收口在内部处理）
    return run;
  }

  private async assembleAndRun(item: StewardAskItem): Promise<StewardAskResultPayload> {
    try {
      return await this.assembleAndRunInner(item);
    } catch (err) {
      // 装配段异常（快照/记忆召回/引擎构造失败）：占位必须释放（占位提前后
      // 的必需兑底——否则 runActive 永真死锁队列）；收口 error 回执后返。若
      // runActive 已被 finishRun/看门狗复位（收口后竞态），原样上抛。
      if (!this.core.run.active) throw err;
      this.core.run.assemblyFailed(); // 批 2：释放占位 + 清锚（不误伤下一 run）
      this.core.runSettledMark?.();
      this.core.runSettledMark = undefined;
      const payload: StewardAskResultPayload = {
        status: "error",
        reason: `引擎装配异常：${(err as Error).message}`,
        errorKind: "engine-exception",
      };
      this.settleAsk(payload);
      this.core.deps.logger?.warn(
        `管家 run 收口：error（分类：engine-exception；原因：引擎装配异常：${capChars((err as Error).message, 200)}；排队 ${this.core.askQueue.length} 条）`,
      );
      const next = this.core.askQueue.shift();
      if (next !== undefined) {
        void this.driveAsk(next).catch(() => undefined);
      }
      return payload;
    }
  }

  private async assembleAndRunInner(item: StewardAskItem): Promise<StewardAskResultPayload> {
    this.core.dialog.ensureLoaded();
    const systemPrompt = assembleStewardSystemPrompt(
      await this.buildSnapshotSafely(),
      // 记忆批（同轨换轨）：机械召回注入退役（原 recallSection(item.text)
      // 注入点）——管家记忆消费改走 memory_search 工具：LLM 按纪律主动
      // 检索，query 自对用户话语（含 ASR 转写）提炼重写，检索更准；多一次
      // 工具调用的开销用户已接受。
      // 语音闭环批 ①：在途提案段（LLM 路径上下文增强——pending 非空时引导
      // 把用户补充话语对齐确认/取消/目标修正，对齐失败才按新指令；词表快路径
      //（TR-240）在 ask 入口先行，两者叠加不冲突）
      buildPendingProposalsSection(this.core.ledger.entries().map((e) => e.action)),
    );
    if (this.core.engine === undefined) {
      const keepRecent = this.core.deps.compaction?.keepRecent ?? STEWARD_COMPACTION_KEEP_RECENT;
      // 代际守卫：persistentListener 捕获本引擎引用——clearHistory 弃旧引擎后
      // 其残余事件（abort 收口帧）不再进入服务面（防污染新 run 状态）
      let engineRef: AgentEnginePort;
      engineRef = this.core.deps.createEngine({
        systemPrompt,
        tools: this.core.toolSpecs,
        gatedTools: GATED_TOOLS,
        persistentListener: (event) => {
          if (this.core.engine === engineRef) this.onEngineEvent(event);
        },
        initialMessages: this.core.dialogSnapshotMessages(),
        compaction: {
          thresholdTokens: this.core.deps.compaction?.thresholdTokens ?? STEWARD_COMPACTION_THRESHOLD_TOKENS,
          keepRecent,
          summarizeInstructions: STEWARD_COMPACTION_SUMMARY_PROMPT,
          summarize: async (_systemPrompt, messages) => {
            // 管家摘要身份自带（STEWARD_COMPACTION_SUMMARY_PROMPT）——pi 侧
            // systemPrompt 是英文常量（customInstructions 落 user 消息不落 sys）
            const response = await this.core.deps.llm.complete({
              systemPrompt: STEWARD_COMPACTION_SUMMARY_PROMPT,
              messages,
              tools: [],
            });
            if (response.kind !== "blocks") {
              throw new Error(`压缩摘要响应非块集（${response.kind}）`);
            }
            return stewardBlocksText(response.blocks);
          },
        },
      });
      this.core.engine = engineRef; // 代际守卫锚（listener 闭包比对同一引用）
    } else {
      this.core.engine.setSystemPrompt?.(systemPrompt);
    }
    this.core.run.begin(); // 批 2：run 开始赋值块（幂等占位/锚定推进锚/清双锚/重置 runState/清 gate 锚）
    this.core.logInfo(`管家 run 开始：${item.text.slice(0, 40)}`);
    this.core.pendingRunAsk = item;
    this.core.askStreamEvents = item.events;
    this.core.currentPause = [];
    const settled = new Promise<StewardAskResultPayload>((resolve) => {
      this.core.askSettler = resolve;
    });
    let markSettled!: () => void;
    this.core.runSettled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    this.core.runSettledMark = markSettled;
    // run 收口由 start() promise 驱动（agent_end 事件早于 pi run promise 收口
    // ——事件面 settle 会与引擎 busy 态竞态：队列驱动 start 撞「already
    // processing」；promise 面收口 = 真 idle 保证）
    void this.core.engine!
      .start(item.text, () => undefined)
      .then(() => {
        this.enqueueProjection(async () => {
          await this.finishRun();
        });
      })
      .catch((err: unknown) => {
        this.enqueueProjection(async () => {
          await this.finishRun(`引擎驱动异常：${(err as Error).message}`);
        });
      });
    return settled;
  }

  /** 引擎事件入口（persistentListener——trace 出口 + 流式回调转发 + 顺序化投影）。 */
  private onEngineEvent(event: AgentEngineEvent): void {
    this.core.run.touch(); // 看门狗推进锚（任何引擎事件 = 活跃）
    this.core.deps.emitEngineEvent?.(event);
    this.core.outlet.forwardStreamCallbacks(event);
    // 轮数熔断（同步判定——async 投影链赶不上无思考工具风暴；abort 越早越省）
    if (event.type === "tool_execution_start") {
      this.core.run.state.toolCalls += 1;
      if (this.core.run.state.toolCalls > this.core.tuningOf().run.maxToolRounds && !this.core.run.state.roundLimit) {
        this.core.run.state.roundLimit = true;
        this.core.engine?.abort();
      }
    }
    this.enqueueProjection(() => this.projectEngineEvent(event));
  }

  /** 投影链追加（顺序化：KV 写入与收口/队列驱动严格定序）。 */
  private enqueueProjection(step: () => Promise<void>): void {
    this.core.projectionChain = this.core.projectionChain.then(step).catch((err) => {
      this.core.deps.logger?.warn(`管家事件投影异常：${(err as Error).message}`);
    });
  }

  /** 引擎事件投影（顺序化执行：KV 入账 / 暂停处理 / 压缩 / run 收口）。 */
  private async projectEngineEvent(event: AgentEngineEvent): Promise<void> {
    switch (event.type) {
      case "message_end":
        await this.projectMessageEnd(event);
        return;
      case "engine_error":
        if (this.core.run.state.softError === undefined) this.core.run.state.softError = event.message;
        return;
      case "tool_execution_start":
        return; // 计数与熔断在 onEngineEvent 同步段（见上）
      case "engine_paused":
        await this.handleEnginePaused(event);
        return;
      case "compaction_completed":
        // 事故热修批⑤：压缩器输出是内部上下文状态不是用户话轮——落
        // kind=compaction（不再伪装 kind=user；LLM 窗口重建经 recordToMessage
        // 转换为摘要消息注入上下文，压缩机制语义不变，仅落库与 UI 回放退出
        // user 轮域——2026-10-07 事故「## Goal（无…）压缩器工作规则」被渲染
        // 成用户发言的污染形态根修）。
        await this.core.dialog.compact(
          { kind: "compaction", text: event.summary, at: this.core.now() },
          this.core.deps.compaction?.keepRecent ?? STEWARD_COMPACTION_KEEP_RECENT,
        );
        return;
      case "agent_end":
        return; // run 收口由 start() promise 驱动（真 idle 保证——见 driveAsk 注释）
      default:
        return;
    }
  }

  /** message_end → 工作记忆 KV（原 recordLoopMessage 的事件投影形态）。 */
  private async projectMessageEnd(
    event: Extract<AgentEngineEvent, { type: "message_end" }>,
  ): Promise<void> {
    if (event.role === "user") {
      // E-198 截断标记（AbortShaping 注入——固定常量文本非用户输入）照常
      // 入账（回放完整性）；user 形态记录统一带 at。
      const at = this.core.now();
      await this.core.pushRecord({ kind: "user", text: event.text, at });
      return;
    }
    if (event.role === "toolResult") {
      await this.core.pushRecord({
        kind: "toolResult",
        toolCallId: event.toolCallId ?? "",
        name: event.toolName ?? "",
        text: event.text,
        at: this.core.now(),
      });
      return;
    }
    if (event.stopReason === "aborted") this.core.run.state.sawAborted = true;
    if (event.stopReason === "error") {
      // 回执文案前缀（与迁移前 streamFn 包装等价——provider 原文随附）；
      // 事故热修批⑦：分类锚定 model-failure（provider 流错误——与工具面
      // aborted / 闸面 terminate 分记，收口日志不再一律记成模型失败）
      this.core.run.state.hardError =
        event.text.trim() !== "" ? `模型调用失败：${event.text}` : this.core.run.state.hardError ?? "模型调用失败";
      this.core.run.state.hardErrorKind = "model-failure";
      return; // error 消息不入 KV（半成品）——错误经回执交代
    }
    const blocks = event.blocks ?? [];
    // abort 半截轮无完整内容：零 assistant 记录（无「（无回答）」污染——
    // loop 无痕语义的对齐面；有文本/thinking 时照记）
    if (event.stopReason === "aborted" && blocks.length === 0 && event.text.trim() === "") return;
    const toolCall = blocks.find((b): b is Extract<typeof b, { type: "toolCall" }> => b.type === "toolCall");
    const thinkingBlocks = blocks.filter((b): b is Extract<typeof b, { type: "thinking" }> => b.type === "thinking");
    const text = toolCall !== undefined || event.text.trim() !== "" ? event.text : "（无回答）";
    if (toolCall === undefined && event.text.trim() !== "") this.core.run.state.lastAnswerText = event.text;
    const thinkingText = thinkingBlocks.map((b) => b.text).join("\n");
    const signature = thinkingBlocks.find((b) => b.signature !== undefined && b.signature !== "")?.signature;
    await this.core.pushRecord({
      kind: "assistant",
      ...(text !== "" || toolCall !== undefined ? { text } : {}),
      ...(thinkingText !== ""
        ? { thinking: signature !== undefined ? { text: thinkingText, signature } : { text: thinkingText } }
        : {}),
      ...(toolCall !== undefined ? { toolCall: { id: toolCall.id, name: toolCall.name, args: toolCall.args } } : {}),
      at: this.core.now(),
    });
  }

  /** 挂闸处理（原 beforeToolCallPause 校验体的 engine_paused 形态）。 */
  private async handleEnginePaused(
    event: Extract<AgentEngineEvent, { type: "engine_paused" }>,
  ): Promise<void> {
    const gated = await this.core.toolKit.gateWriteTool({
      runId: "",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: (event.args ?? {}) as Record<string, unknown>,
    });
    if (!gated.pause) {
      // read 档直行（M2 act）：approve 放行——工具正常执行（免确认直行）
      if (gated.approve === true) {
        await this.core.engine?.resume?.(event.pauseToken, { kind: "approve" });
        return;
      }
      // 校验未过直出（原 pause:false + outcome 路径）：guidance → reject
      // （模型知情续跑）；terminate → resolve 翻译（结果入账 + run 终结）。
      const outcome = gated.outcome;
      if (outcome !== undefined && outcome.kind === "terminate") {
        this.core.run.state.hardError = outcome.reason;
        this.core.run.state.hardErrorKind = "engine-error"; // 闸面终止（非模型失败——分记）
        await this.core.engine?.resume?.(event.pauseToken, { kind: "resolve", text: outcome.reason });
      } else {
        const text = outcome !== undefined && outcome.kind === "result" ? outcome.text : "提案未通过校验";
        await this.core.engine?.resume?.(event.pauseToken, { kind: "reject", text });
      }
      return;
    }
    // ── 批 1：提案登记收编 ProposalLedger（三路判别在聚合内；凭据换血 =
    //    action.toolCall + pauseToken 归聚合）。一次 run 至多一个未决提案
    //    （currentPause 归属——run 生命周期，批 2 迁 run 子域）。──
    const action: PendingAction = {
      ...gated.action,
      toolCall: { id: event.toolCallId, name: event.toolName },
    };
    const proposed = this.core.ledger.propose(action, { pauseToken: event.pauseToken });
    if (proposed.kind === "reused") {
      // 登记簿①：在途同 key → 复用旧卡（幂等：不新弹不新凭据；凭据换血
      // 到活 run 的 pauseToken——回灌链路续活，TTL 重置新确认窗口）
      this.core.currentPause.length = 0;
      this.core.currentPause.push({ actionId: proposed.actionId, action: proposed.entry.action });
      this.core.run.gate(event.pauseToken);
      this.core.logInfo(
        `管家确认闸复用在途提案卡：${proposed.actionId}（${gated.action.kind} → ${gated.action.displayTarget}）——同 key 幂等不新弹`,
      );
      this.settleAsk({
        status: "confirm_required",
        actionId: proposed.actionId,
        agentId: gated.action.displayTarget,
        message: gated.action.message,
      });
      return;
    }
    if (proposed.kind === "blocked") {
      // 登记簿②：已成功终局 → 不挂闸：回灌「已做过」（带原 actionId）
      this.core.logInfo(
        `管家确认闸拦截重复提案：${gated.action.kind} → ${gated.action.displayTarget}（已执行过 ${proposed.settled.actionId}）`,
      );
      await this.core.engine?.resume?.(event.pauseToken, {
        kind: "resolve",
        text: capToolResultText(`该操作已执行过（${proposed.settled.actionId}）：${proposed.settled.detail}——无需重复确认，可向用户说明`),
      });
      return;
    }
    const actionId = proposed.actionId;
    this.core.logInfo(`管家确认闸暂停：${actionId}（${gated.action.kind} → ${gated.action.displayTarget}）`);
    this.core.currentPause.length = 0; // 一次 run 至多一个未决提案（挂闸即收口）
    this.core.currentPause.push({ actionId, action: proposed.entry.action });
    this.core.run.gate(event.pauseToken);
    this.settleAsk({
      status: "confirm_required",
      actionId,
      agentId: gated.action.displayTarget,
      message: gated.action.message,
    });
  }

  /** run 收口（agent_end）：结果推导 + deliver + 队列驱动。
   *  确认链路修复批：error 收口日志附引擎错误摘要（事故 run#3/#5/#7 无原因）
   *  + 本 run 挂闸卡生命周期处置（deliver 类续活 / destructive 撤除+明示）。
   *  事故热修批④：幂等守卫（runActive=false 时直接回——防看门狗强制收口与
   *  自然收口双发驱动队列）；⑦：error 收口日志与回执携 errorKind 分类
   *  （aborted 与模型失败分记——act 挂闸 60s 后收口不再被误归模型失败）。 */
  private async finishRun(startError?: string): Promise<void> {
    if (!this.core.run.active) return; // 幂等守卫（事故热修批④）
    this.core.run.finish(); // 批 2：收口清块（runActive=false + 三锚复位）
    this.core.runSettledMark?.();
    this.core.runSettledMark = undefined;
    const outcome: StewardAskResultPayload =
      startError !== undefined
        ? { status: "error", reason: startError, errorKind: "engine-exception" }
        : this.outcomeOfRun();
    // ⑤ error 收口附原因摘要 + 分类分记（warn 级保证可见——旧装配 info 缺席
    //    时事故零日志；分类面让 aborted/模型失败/引擎异常可区分归因）
    if (outcome.status === "error") {
      const kind = outcome.errorKind ?? "-";
      this.core.deps.logger?.warn(
        `管家 run 收口：error（分类：${kind}；原因：${capChars(outcome.reason, 200)}；排队 ${this.core.askQueue.length} 条）`,
      );
      // 健康上报（光球角标批）：模型/引擎级失败 = llm 降级；aborted（用户
      // 手动停止）非故障不上报
      if (kind !== "aborted") this.core.deps.emitHealth?.("llm", "degraded", outcome.reason);
    } else {
      this.core.logInfo(`管家 run 收口：${outcome.status}（排队 ${this.core.askQueue.length} 条）`);
      this.core.deps.emitHealth?.("llm", "ok"); // 正常收口 = llm 恢复
    }
    // ④ 本 run 挂闸卡处置：deliver/send/create/spawnReview 意图不随 run 死
    //    而失效 → 凭据续活到卡终局；destructive 不可续活 → 即时撤除+明示。
    this.disposeRunPendingCards();
    const item = this.core.pendingRunAsk;
    this.core.pendingRunAsk = undefined;
    this.core.run.ungate();
    this.core.askStreamEvents = {};
    this.settleAsk(outcome);
    item?.deliver?.(outcome);
    const next = this.core.askQueue.shift();
    if (next !== undefined) {
      void this.driveAsk(next).catch((err) => {
        this.core.deps.logger?.warn(`队列驱动异常：${(err as Error).message}`);
      });
    }
  }

  /** run 收口挂闸卡处置（确认链路修复批④；批 1 起判定收编聚合）：currentPause
   *  即本 run 提案锚（一次 run 至多一个未决提案）；已终局（confirm/cancel
   *  先行）零处置；非 destructive 续活、destructive 撤除+明示（翻译面）。 */
  private disposeRunPendingCards(): void {
    const { kept, withdrawn } = this.core.ledger.resolveRunCards(this.core.currentPause.map((p) => p.actionId));
    for (const { actionId, action } of kept) {
      this.core.logInfo(
        `确认卡续活（run 收口不撤）：${actionId}（${action.kind} → ${action.displayTarget}）——意图不随 run 死而失效`,
      );
    }
    for (const { actionId, action } of withdrawn) {
      this.core.routing.settleProposal(pendingKeyOf(action), "voided", actionId, "run 收口撤除（destructive 不可续活）");
      this.core.deps.emitActionCompleted?.({
        actionId,
        ok: false,
        detail: "该操作已撤回（原运行已结束，高风险操作不自动保留）——如仍需要请重新提出",
        outcome: "superseded",
      });
      this.core.outlet.emitLifecycleNotify(
        "normal",
        "高风险操作已撤回",
        `原运行已结束，「${action.displayTarget}」的高风险操作卡已撤除；如仍需要请重新提出`,
      );
    }
    this.core.currentPause = [];
  }

  /** run 结果推导（事件态 → 回执判别——原 mapRunResult）。事故热修批⑦：各
   *  error 分支携 errorKind（aborted 与模型失败分记——日志/回执可区分归因）。 */
  private outcomeOfRun(): StewardAskResultPayload {
    // aborted 优先于一切（半截文本不作终答回执——协议面回执恒 aborted error）；
    // 次之 answer（压缩失败 engine_error 不吞终答——fail-open）；最后 error
    if (this.core.run.state.roundLimit) {
      return {
        status: "error",
        reason: `工具循环超限（>${this.core.tuningOf().run.maxToolRounds} 轮熔断）——请缩小问题范围或重试`,
        errorKind: "round-limit",
      };
    }
    if (this.core.run.state.sawAborted) {
      return {
        status: "error",
        reason: "管家对话已被中止（abort——可重发；排队中的输入不受影响）",
        errorKind: "aborted",
      };
    }
    if (this.core.run.state.hardError !== undefined) {
      return {
        status: "error",
        reason: this.core.run.state.hardError,
        ...(this.core.run.state.hardErrorKind !== undefined ? { errorKind: this.core.run.state.hardErrorKind } : {}),
      };
    }
    if (this.core.run.state.lastAnswerText.trim() !== "") {
      return { status: "answer", text: this.core.run.state.lastAnswerText };
    }
    if (this.core.run.state.softError !== undefined) {
      return { status: "error", reason: this.core.run.state.softError, errorKind: "engine-error" };
    }
    return { status: "answer", text: "（无回答）" };
  }

  /** ask promise 收口（confirm_required 在挂闸即收；其余在 finishRun）。
   *  runSettled 不在此收——移 finishRun（暂停态新 ask 的 abort-再驱动需等
   *  引擎真 idle，而非 confirm_required 收口时点）。 */
  private settleAsk(payload: StewardAskResultPayload): void {
    const settle = this.core.askSettler;
    this.core.askSettler = undefined;
    settle?.(payload);
  }
  // ── 可靠性批（2026-10-06 事故根修）：看门狗 + 确认闸 TTL + 可达性提醒 ──
  // 三要素兑底：确认闸无超时（TTL）、run 无看门狗（watchdog）、挂起无日志
  // （生命周期日志面）。生产定时器由组合根 startReliabilityTimers 启动，
  // 测试直接调 reliabilityTick（注入时钟——E-240 行为等价不变量不受影响）。

  /** 启动可靠性巡检定时器（生产面；幂等——stewardMemory.startGcTimer 先例）。 */
  startReliabilityTimers(): void {
    if (this.core.reliabilityTimer !== undefined) return;
    const timer = setInterval(() => this.reliabilityTick(), this.core.tuningOf().run.watchdogTickMs);
    timer?.unref?.(); // TR-152 落盘面定时器纪律：不阻进程退出
    this.core.reliabilityTimer = timer;
  }

  /** StewardComponent 契约（批 0 生命周期登记表）：start/stop 映射既有
   *  可靠性巡检定时器面（幂等语义不变）。 */
  start(): void {
    this.startReliabilityTimers();
  }

  stop(): void {
    this.stopReliabilityTimers();
  }

  /** 停巡检定时器（shutdown 链挂点/测试清理）。 */
  stopReliabilityTimers(): void {
    if (this.core.reliabilityTimer === undefined) return;
    clearInterval(this.core.reliabilityTimer);
    this.core.reliabilityTimer = undefined;
  }

  /** 可靠性巡检单拍（看门狗 → 可达性提醒 → 确认闸 TTL；幂等可重入）。 */
  reliabilityTick(): void {
    const now = this.core.now();
    this.checkRunWatchdog(now);
    this.checkConfirmReminders(now);
    this.checkConfirmTtl(now);
  }

  /** run 看门狗 tick（批 2：判定收编 RunWatchdog 纯函数——六态穷举表驱动，
   *  domain/steward/run/RunWatchdog；副作用翻译在本方法）。原判定序与文案
   *  逐分支等价（含 CAND-666 哨兵防御/挂闸等待零通知/手动快进优先于被动轨）。 */
  private checkRunWatchdog(now: number): void {
    const verdict = judgeRunWatchdog(this.core.run.watchdogSnapshot(this.core.engine !== undefined), this.core.tuningOf(), now);
    switch (verdict.kind) {
      case "idle-reset":
        // 空闲态复位（下一 run 重计）——容器无独立复位方法：idle 即未触发
        return;
      case "unanchored":
      case "none":
        return;
      case "manual-fast-forward": {
        // 手动 abort 快进轨——abort 打不醒的挂死流不等被动看门狗（180s）
        this.forceRecoverRun(
          `手动停止快进：abort 后 ${this.core.tuningOf().run.manualAbortGraceMs / 1000}s 未收口（挂死流——abort 打不醒）——弃引擎重建并恢复队列`,
        );
        return;
      }
      case "arm": {
        this.core.run.armWatchdog();
        const gatedWait = this.core.ledger.size > 0; // 挂闸等待：有卡待确认（合法业务态）
        this.core.deps.logger?.warn(
          `管家 run 看门狗触发：挂起 ${verdict.hungSeconds}s 无事件推进${gatedWait ? "（挂闸等待中——pending 有卡）" : ""}——abort 在途轮${gatedWait ? "（等待态零通知）" : "并通知"}`,
        );
        if (!gatedWait) {
          // 恢复通知只留给「用户在等答案却被挂死」场景；挂闸等待用户知情
          // （有卡挂着），「已自动恢复」是惊扰噪音（2026-10-07 事故修订 CAND-666）
          this.core.outlet.emitLifecycleNotify(
            "high",
            "管家已自动恢复",
            `管家处理挂起 ${verdict.hungSeconds}s 无响应，已自动中止恢复；排队中的输入将继续处理`,
          );
        }
        this.core.routing.abortInFlight("run 看门狗：挂起超时"); // 挂闸阻塞的 run 被唤醒收口（raceAbort）
        return;
      }
      case "force-recover": {
        this.core.run.armWatchdog(); // 周期性兜底重置（极端场景下每宽限窗再查）
        this.forceRecoverRun(verdict.reason);
        return;
      }
    }
  }

  /** 强制收口轨（手动停止批提取；挂死流唯一恢复路径——E-240）：看门狗宽限段
   *  与手动停止快进段共用。弃引擎（代际守卫隔离旧引擎残余事件）+ 经投影链
   *  finishRun（队列驱动/deliver 回执/挂闸卡处置全走既有收口面）。 */
  private forceRecoverRun(reason: string): void {
    this.core.run.forceRecoverPrepared(); // 同步清锚防重（finishRun 异步，重复 tick 不二触）
    this.core.engine = undefined; // 弃引擎（下一 run 懒重建；代际守卫隔旧事件）
    this.core.run.ungate();
    this.core.deps.logger?.warn(`管家 run 强制收口：${reason}`);
    this.enqueueProjection(() => this.finishRun(reason));
  }

  /** 确认可达性提醒（语音闭环批 ②聚合版）：任一卡到 30s 未消费 → 按 pending
   *  全集 N 出**一条**提醒（N=1 维持现单条文案；N≥2 合并「管家有 N 个操作
   *  等你确认」）且覆盖全集（全部置 remindedAt——后熟卡零二次提醒）。治事故
   *  「两张同模板卡各弹一条（body 仅目标不同 → 去重 key 不同全放行）」。 */
  private checkConfirmReminders(now: number): void {
    // 批 1：成熟判定/覆盖全集收编聚合；文案与帧发射留翻译面
    const matured = this.core.ledger.remindDue(now, this.core.tuningOf().confirm.remindAfterMs);
    if (matured === undefined) return;
    const total = matured.total;
    if (total >= 2) {
      this.core.logInfo(
        `管家确认卡可达性提醒（聚合）：pending ${total} 张（首成熟 ${matured.first.actionId}——${matured.first.entry.action.displayTarget}）——${this.core.tuningOf().confirm.remindAfterMs / 1000}s 无人消费`,
      );
      this.core.outlet.emitLifecycleNotify(
        "normal",
        "待确认操作",
        `管家有 ${total} 个操作等你确认——打开管家面板处理；${this.core.tuningOf().confirm.ttlMs / 1000}s 内未确认将自动作废`,
      );
      return;
    }
    this.core.logInfo(
      `管家确认卡可达性提醒：${matured.first.actionId}（${matured.first.entry.action.displayTarget}）——${this.core.tuningOf().confirm.remindAfterMs / 1000}s 无人消费`,
    );
    this.core.outlet.emitLifecycleNotify(
      "normal",
      "待确认操作",
      `管家有一个操作等你确认（${matured.first.entry.action.displayTarget}）——打开管家面板处理；${this.core.tuningOf().confirm.ttlMs / 1000}s 内未确认将自动作废`,
    );
  }

  /** 确认闸 TTL（语音闭环批 ②聚合版）：pending 卡超 tuning.confirm.ttlMs（批 0 起 KV 可配）无
   *  confirm/cancel → 自动作废（复用 cancel 内部语义——删除即作废，两段式不变
   *  量不动：作废后再 confirm 报已消费）+ 逐卡 action.completed 超时回执广播
   *  （卡栈同步面不聚合）+ **同批用户提醒合并一条**（N=1 现文案 / N≥2「N 个
   *  确认已超时作废」——治同批多卡逐条弹失效通知轰炸）。 */
  private checkConfirmTtl(now: number): void {
    // 批 1：到期批次作废收编聚合；回执/日志/提醒留翻译面（cancel 同款作废
    // 语义——删除即作废不清挂闸旗，挂闸 run 由看门狗/abort-再驱动收口）
    const expired = this.core.ledger.expireDue(now, this.core.tuningOf().confirm.ttlMs);
    for (const { actionId, entry } of expired) {
      this.core.ledger.markExpired(actionId); // 逐个删除（已被同 key 收敛先行删除 → no-op；帧照快照无条件发——原版时序）
      this.core.deps.logger?.warn(
        `管家确认卡 TTL 作废：${actionId}（${entry.action.kind} → ${entry.action.displayTarget}）——${this.core.tuningOf().confirm.ttlMs / 1000}s 无人确认自动作废`,
      );
      this.core.deps.emitActionCompleted?.({ actionId, ok: false, detail: STEWARD_CONFIRM_TIMEOUT_DETAIL, outcome: "timeout" });
      // 终局登记 + 同 key 收敛（确认链路修复批：作废也收敛，零后续连锁通知）
      this.core.routing.settleProposal(entry.key ?? pendingKeyOf(entry.action), "voided", actionId, "确认超时作废");
    }
    if (expired.length === 0) return;
    if (expired.length >= 2) {
      this.core.outlet.emitLifecycleNotify(
        "normal",
        "确认已超时",
        `${expired.length} 个操作超过 ${this.core.tuningOf().confirm.ttlMs / 1000}s 未确认，已自动作废；如仍需要请重新向管家提出`,
      );
      return;
    }
    const single = expired[0]!;
    this.core.outlet.emitLifecycleNotify(
      "normal",
      "确认已超时",
      `操作「${single.entry.action.displayTarget}」超过 ${this.core.tuningOf().confirm.ttlMs / 1000}s 未确认，已自动作废；如仍需要请重新向管家提出`,
    );
  }

  /** 工作记忆读面（steward.history 回放：完整记录数组——UI 渲染与 LLM 窗口
   *  同源重建；A1 批）。 */
  async getHistory(): Promise<readonly StewardHistoryRecord[]> {
    return this.core.dialog.snapshot();
  }

  /** 新对话闸（steward.history {clear:true}：KV + daemon LLM 窗口同清——
   *  前端显示由回执空数组同步；A1 批）。pending 确认卡随之作废（自然过期）。 */
  async clearHistory(): Promise<void> {
    this.core.ledger.clear();
    await this.core.dialog.clear();
    // 段B：引擎销毁重建（下一问从空窗口——与清空后 KV 同源；dialog 已清，
    // 懒构造下一问以空 initialMessages 重建）。挂闸阻塞中的 run 先 abort 释放
    //（闸内 raceAbort 唤醒）再弃引用；runActive 复位防新 ask 误判 busy。
    this.core.engine?.abort();
    this.core.engine = undefined;
    // 在途/排队 ask 先收口再清状态（孤儿化修复：askSettler 只置空不 settle
    // 的话，在途 ask 的 promise 永不 resolve——handler 的 steward.ask.result
    // 帧永不回执，UI 该轮永久等待；runSettledMark 同步收口防 abort-再驱动
    // 路径的 awaiter 挂死；排队项逐个 deliver 作废回执——新对话语义下不再
    // 处理，但发起面必须拿到终帧）。clearAll 后 finishRun 幂等守卫直接回，
    // 自然收口路径不会二次 settle——此处是唯一收口点。）
    const droppedItems = this.core.askQueue.drainAll();
    if (droppedItems.length > 0) this.core.logInfo(`管家新对话：丢弃排队 ${droppedItems.length} 条`);
    for (const queuedItem of droppedItems) {
      queuedItem.deliver?.({ status: "error", reason: "对话已清空（新对话）——排队输入作废", errorKind: "aborted" });
    }
    const clearedPayload: StewardAskResultPayload = {
      status: "error",
      reason: "对话已清空（新对话）——本轮已被中止",
      errorKind: "aborted",
    };
    const item = this.core.pendingRunAsk;
    this.core.pendingRunAsk = undefined;
    this.core.askStreamEvents = {};
    this.settleAsk(clearedPayload);
    this.core.run.clearAll(); // 批 2：run 态全复位
    this.core.runSettledMark?.();
    this.core.runSettledMark = undefined;
    item?.deliver?.(clearedPayload);
   }

  /** 快照段组装（感知查询失败静默降级 = undefined；绝不能挡对话主链路）。
   *  数据源与工具面同源：活跃 agent 数 = orchestration.status()（与
   *  list_instances 同一调用面）；会话计数与主题 = sessions 源（与
   *  query_recent_work 同一读面）；M3-d1 活动段 = recentActivity 读面
   *  （活动账白话行——**分段降级**：活动面抛错只缺席活动段，基础段照常）。 */
  private async buildSnapshotSafely(): Promise<string | undefined> {
    if (this.core.deps.sessions === undefined) return undefined;
    try {
      const rows = await this.core.deps.sessions.listSessionMetadata();
      const statuses = this.core.deps.orchestration.status();
      const activeAgents = statuses.filter((s) => s.state === "running").length;
      // M3-d1：活动段读面独立降级（读面抛错 → 零活动段，快照基础段照常——
      // 现 assembleStewardSystemPrompt 附加段缺席语义）
      let recentActivity: readonly { at: number; domain: string; attribution: string; text: string }[] | undefined;
      try {
        recentActivity = this.core.deps.recentActivity?.();
      } catch (err) {
        this.core.deps.logger?.warn(`管家快照活动段读面降级（快照仅基础段）：${(err as Error).message}`);
        recentActivity = undefined;
      }
      return buildContextSnapshot({
        nowMs: this.core.now(),
        activeAgents,
        totalAgents: statuses.length,
        sessionCount: rows.length,
        recentSessions: rows.slice(0, SNAPSHOT_RECENT_SESSIONS).map((r) => ({
          // displayTitle 单源（TR-207）：推导链只在 displayTitleOf，快照面禁另写
          title: displayTitleOf(r),
          updatedAt: r.updatedAt,
        })),
        ...(recentActivity !== undefined && recentActivity.length > 0 ? { recentActivity } : {}),
      });
    } catch (err) {
      this.core.deps.logger?.warn(`管家情景快照组装失败（降级为无快照段）：${(err as Error).message}`);
      return undefined;
    }
  }
}
