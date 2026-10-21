/**
 * StewardRouting —— 管家分诊路由域（体量门 P4：自 StewardService 迁出）。
 *
 * 职责（trigger 判定 + 门禁）：入站 ask 的判定漏斗与排队接管（词表口令 →
 * 停止判定 → 意图泛化 → addressee 分诊）、意图/停止判官消费面、确认闸
 * 放行/作废/执行体与终局登记（门禁）。状态与共享编排态全部由 StewardCore
 * 持有——本类只做判定与翻译，不含 run 生命周期与出口帧组装。
 *
 * 纪律来源：E-276（语音输入判定四层链）/ TR-240（确认链路状态面）/
 * E-292（停止两轨 scope 与 runEpoch 代际守卫）/ E-305（barge-in 判停单轨）。
 * 行为零变更：方法体自 StewardService 逐段搬运，仅把 `this.<共享状态>`
 * 改写为 `this.core.<共享状态>`，跨域调用改经 `this.core.<域>`。
 */
import { STEWARD_TUNING_DEFAULTS } from "../../domain/steward/tuning/StewardTuning";
import { judgeOrFallback } from "../../domain/steward/utterance/JudgePolicy";
import { pendingKeyOf, type PendingAction } from "../../domain/steward/confirmation/ProposalLedger";
import type {
  StewardActionCompletedPayload,
  StewardAskResultPayload,
  StewardAskSource,
  StewardConfirmResultPayload,
} from "@helix/protocol";
import {
  STEWARD_ADDRESSEE_QUESTION,
  STEWARD_INTENT_JUDGE_CANCEL_QUESTION,
  STEWARD_INTENT_JUDGE_CONFIRM_QUESTION,
  STEWARD_INTENT_JUDGE_REVISE_QUESTION,
  STEWARD_STOP_QUESTION,
  buildIntentJudgeState,
  buildIntentReviseAskText,
  isAmbientSpeech,
  isStopIntent,
  pickIntentByScores,
} from "./StewardIntentJudge";
import { capChars, capToolResultText, formatActReceipt, matchStewardCommandPhrase } from "./stewardProjections";
import type { StewardCore } from "./StewardCore";
import type { StewardAskEvents, StewardAskItem } from "./stewardServiceTypes";

/** 分诊路由域协作面（跨域窄接口——本域不发帧、不驱动 run 生命周期）。 */
export interface StewardRoutingHost {
  /** run 驱动（生命周期域：同步占位 + 装配 + 引擎启动）。 */
  driveAsk(item: StewardAskItem): Promise<StewardAskResultPayload>;
  /** 生命周期提醒帧播报（播报编排域；订阅闸/限流在 EventStream 侧）。 */
  emitLifecycleNotify(urgency: "normal" | "high", title: string, body: string): void;
}

export class StewardRouting {
  private readonly core: StewardCore;
  /** 跨域协作面（run 驱动 / 提醒播报——域间不直连别域类，见接口注释）。 */
  private readonly host: StewardRoutingHost;

  constructor(core: StewardCore, host: StewardRoutingHost) {
    this.core = core;
    this.host = host;
  }

  async ask(
    text: string,
    events: StewardAskEvents = {},
    deliver?: (payload: StewardAskResultPayload) => void,
    source: StewardAskSource = "text",
  ): Promise<StewardAskResultPayload> {
    if (typeof text !== "string" || text.trim() === "") {
      return { status: "error", reason: "payload.text 应为非空 string" };
    }
    if (!this.core.isEnabled()) {
      return {
        status: "error",
        reason: "管家未开启：请在设置页 → 通用配置开启（开关关 = 零 LLM 调用）",
      };
    }
    // 感知激活信号②：ask 即点亮衰减窗（一问即入激活——响应环点亮主动环）
    this.core.deps.onUserActivity?.();
    // 确认口令路由（确认链路修复批③，事故 12:27:45 实锤：「确认了很多遍」
    // 被当新指令又弹卡）：pending 卡存在时纯文本口令绑定最近一张卡消费/作废
    // ——零 LLM 零新提案；无 pending 卡时原样走 LLM。极轻判定先于队列语义
    //（挂闸阻塞中口令确认 = 面板点卡的等价入口）。
    const phrase = matchStewardCommandPhrase(text);
    if (phrase !== undefined) {
      const routed = this.routeConfirmPhrase(phrase);
      if (routed !== undefined) return routed;
    }
    // 强制停止判定（Jev 单轨——停止词表退役批）：在途 run 时停止意图判官
    // 判停 → 全停（abort 当前 + 清空排队，回执携丢弃条数）；判不出（判官
    // 缺席/抛错/降级）照常走队列（fail-open 归漏斗面——不吞用户提问、不动
    // 队列序不变量；shell 打断链的 fail-stop 归其消费面）；无在途原样走 LLM
    // （停止判定仅在场触发，TR-240 同款纪律）。挂闸阻塞态判停同样全停（旧
    // 逻辑会把停止表达当新 ask abort-再驱动——语义错位）；pending 卡不动
    //（卡生命周期 TTL 域独立）。
    if (this.core.run.active) {
      // 判定 await 竞态守卫（评审 low #2）：判官判定是异步 LLM 调用，期间在途
      // run 可能自然收口（判停结论悬空）或被排队接管换代（新 run 与这句停止
      // 表达无关）。记下发问时的 run 代际号（runEpoch，occupy 递增）再判定：
      // ——同 run 仍在途：全停（abort + 清队列）；
      // ——run 已自然收口：停止表达不回落成新一轮 LLM 提问（清队列 + stopped
      //   回执），而不是当新问题再交一次 LLM；
      // ——run 已换代（后继在途）：判停结论对后继无失（后代在服队列里的旧
      //   ask），不误杀后继（abortInFlight 会杀掉它）——交回正常漏斗排队，
      //   与判官缺席的 fail-open 同姿态。
      const epochAtJudge = this.core.runEpoch;
      const stopVerdict = await this.judgeStopIntent(text);
      if (stopVerdict.stop) {
        const sameRunInFlight = this.core.run.active && this.core.runEpoch === epochAtJudge;
        if (sameRunInFlight) {
          const dropped = this.core.askQueue.clearAll();
          this.abortInFlight("停止判定全停");
          this.core.logInfo(`管家手动停止（停止判定判停）：丢弃排队 ${dropped} 条`);
          return { status: "stopped", reason: "已停止当前处理", dropped };
        }
        if (!this.core.run.active) {
          const dropped = this.core.askQueue.clearAll();
          this.core.logInfo(`管家手动停止（判定期间 run 已收口）：丢弃排队 ${dropped} 条`);
          return { status: "stopped", reason: "已停止当前处理", dropped };
        }
      }
    }
    // 判官泛化层（M3-a：三级漏斗第二级）：词表未命中 ∧ pending 卡在场 →
    // 判官 noul 三问分流「确认/取消/修正」。确认/取消复用口令路由执行面
    //（零 LLM 零新提案）；修正 = 撤旧卡 + 按修正后意图新开（一次 LLM 带卡
    // 全文上下文）；三问皆低 = 无关新任务原样走 LLM。判官缺席/关闭/未配/
    // 抛错 → 回退词表后行为零劣化（judgePendingIntent 内降级链）。挂闸
    // 阻塞中泛化确认 = 面板点卡的等价入口（与口令路由同构）。
    if (phrase === undefined) {
      // 判官泛化层先判（层序修复批：卡在场是最强的「对谁说」证据）——
      // 原序 addressee 先判，其问句不带卡上下文，确认卡在场期间主人的自然
      // 回应（「就这么办」「对对对赶紧弄」——词表未命中短句，无称呼无指令
      // 特征）恒判环境音 dropped，永远轮不到带卡全文的泛化判定（用户实锤）。
      // 声纹总闸已在 shell 层拦旁人（reject 整轮终止）——本层只防「主人对
      // 房间里其他人说话」，卡在场时让位：confirm/cancel/revise 分流在前，
      // 三问皆低才退回 addressee 判定。
      const generalized = await this.judgePendingIntent(text);
      if (generalized !== undefined && generalized.intent === "revise") {
        text = generalized.revisedText; // 修正轮输入替换（带卡全文上下文——不再 addressee）
      } else {
        if (generalized !== undefined) {
          const routed = this.routeConfirmPhrase(generalized.intent);
          if (routed !== undefined) return routed;
          // 卡在分类与路由间消失（TTL/并发消费）：零差异回退原样走 LLM
        }
        // addressee 判定（声纹→Jev 链路批）：双工常开麦收音段的「对谁说」
        // 判定——词表未命中才判（词表全等 = 机械权威零判定）；声纹闸在 shell
        // 已拦非用户，本层只判「用户本人是不是在叫管家」。旁人高置信 →
        // dropped 静默丢弃；判官缺席/灰区/抛错 → 偏「当聊天」继续（宁多应答不漏）。
        if (source === "voice-duplex" && (await this.judgeAddressee(text))) {
          return { status: "dropped", reason: "ambient" };
        }
      }
    }
    // 暂停态（挂闸阻塞中）新 ask：loop 语义 = 旧 run 已 settle 过期、新 ask
    // 照常（E-197 迁移前等价）——pi 映射：abort 阻塞中的 run（闸内 raceAbort
    // 唤醒、工具不执行）→ 收口后驱动新 ask（确认卡保持有效：confirm 时
    // pauseToken 已过期自然失效）。
    if (this.core.run.active) {
      if (this.core.run.gateToken !== undefined && this.core.engine !== undefined) {
        this.core.engine.abort();
        await this.core.runSettled;
        return this.host.driveAsk({ text, events, ...(deliver !== undefined ? { deliver } : {}) });
      }
      if (!this.core.askQueue.tryPush({ text, events, ...(deliver !== undefined ? { deliver } : {}) })) {
        return {
          status: "error",
          reason: `管家正在处理中，排队已满（上限 ${this.core.tuningOf().ask.queueMax} 条）——请稍后再试`,
        };
      }
      return { status: "queued", queued: true, position: this.core.askQueue.length };
    }
    return this.host.driveAsk({ text, events });
  }

  /** 在途轮 abort（幂等——非在途态 no-op 返回 false；挂闸阻塞中同样唤醒
   *  收口）。收口后自持队列自动接管（序不变量：队列不丢）。手动停止批：
   *  置位 manualAbortAt 快进锚——abort 打不醒的挂死流（E-240 实测）在宽限
   *  后由快进轨强制收口，不等被动看门狗 180s。 */
  abortInFlight(reason: string): boolean {
    void reason;
    if (!this.core.run.active || this.core.engine === undefined) return false;
    this.core.run.noteAbort(); // 快进锚（手动停止批）
    this.core.engine.abort();
    return true;
  }

  /** 全停（批 3b 两轨裁决乙：语音停止判定通道，steward.interrupt scope=all）
   *  ——与 ask 漏斗停止判定全停同径：abort 当前 + 清空 ask 队列。与轻停
   *  （abortInFlight，队列照常）相对；幂等（无在途时清队列照常——队列在场
   *  即有意义）。返回丢弃条数（日志用）。 */
  interruptAll(reason: string): number {
    const dropped = this.core.askQueue.clearAll();
    this.abortInFlight(reason);
    if (dropped > 0) this.core.logInfo(`管家手动停止（${reason}）：丢弃排队 ${dropped} 条`);
    return dropped;
  }

  /** 确认闸放行（steward.confirm 回执）：单次消费 + 恰一次执行——
   *  **B1 两段式**（设计稿 §3.4）：
   *  ①受理即回：消费 actionId 后立即返 accepted（不 await 执行体——
   *    deliverSession 入 idle 会话的全轮 await 不再阻塞确认链，G1 主根
   *    消除；卡片即时转 accepted 态防双击）；
   *  ②异步执行：executePending 收口后经 onCompleted 回携
   *    {actionId, ok, detail}（点对点 steward.action.completed 帧，成败
   *    两路均发——错误交代面从 confirm.result 迁出）；回灌（resumeWith
   *    resolve）与工作记忆 toolResult 入账语义照旧，仅时点移入执行体。
   *  A2：动作分派（send / createSession / deliverSession / memorize /
   *  spawnReview 判别联合）。helix-loop L0：回灌经 LoopEngine 暂停点
   *  （run_resumed 事件 + appendToolResult 入账）。 */
  async confirm(
    actionId: string,
    onCompleted?: (payload: StewardActionCompletedPayload) => void,
  ): Promise<StewardConfirmResultPayload> {
    // 批 1：单次消费收编聚合（consume = 查卡+删卡一体；执行失败也不可重放）
    const entry = this.core.ledger.consume(actionId);
    if (entry === undefined) {
      // 确认链路修复批：用户语义文案（事故 12:17:16 点死卡只看到内部异常）
      return {
        status: "error",
        reason: `该确认已失效（actionId=${actionId} 不存在或已消费——服务重启/超时作废后凭据即失效）；如仍需要请重新提出`,
      };
    }
    // 暂停态旗同步清（B1 两段式窗口防误伤：执行体异步在飞时新 ask 不走
    // abort-再驱动路径——被弃的是确认流而非挂闸 run）
    if (this.core.ledger.size === 0) this.core.run.ungate();
    // 受理时即广播 navigate（deliverSession——sessionId 提案已知，不再等
    // 执行体全轮；createSession 的 navigate 仍在执行体（sessionId 执行后才
    // 产生））。
    if (entry.action.kind === "deliverSession") {
      this.core.deps.emitNavigate?.({ sessionId: entry.action.deliverSession!.sessionId });
    }
    const key = entry.key ?? pendingKeyOf(entry.action);
    // 异步执行体（受理后启动；错误经 onCompleted 交代，不浮出确认链）
    void (async () => {
      const outcome = await this.executePending(entry.action);
      // 回灌经引擎暂停面（resolve 翻译：结果入账 + run 终结——block+terminate）；
      // B4a 轮外提案无暂停点（pauseToken 缺席）——跳过回灌直接收口。
      // 确认链路修复批：run 已收口/引擎重建后凭据过期 → 降级跳过回灌
      //（事故实锤「审批闸未知 pauseToken」曾把已送达的执行误报为异常）。
      if (entry.pauseToken !== undefined && this.core.engine !== undefined) {
        try {
          await this.core.engine.resume?.(entry.pauseToken, {
            kind: "resolve",
            text: capToolResultText(outcome.detail),
            isError: !outcome.ok,
          });
        } catch (err) {
          this.core.logInfo(`确认卡回灌降级（run 已收口，凭据过期）：${(err as Error).message.slice(0, 80)}`);
        }
      }
      // 终局登记 + 同 key 收敛（succeeded 拦重复提案；失败不记=可重试）
      if (outcome.ok) this.settleProposal(key, "succeeded", actionId, outcome.detail);
      onCompleted?.({ actionId, ok: outcome.ok, detail: outcome.detail });
    })().catch((err: unknown) => {
      // 防御面：执行体异常不该静默（与 outcome.ok=false 同构交代）
      const detail = `确认动作执行异常：${(err as Error).message}`;
      this.core.deps.logger?.warn(detail);
      onCompleted?.({ actionId, ok: false, detail });
    });
    return { status: "accepted", actionId };
  }

  /** 确认卡作废（B1 steward.cancel）：pending 删除即作废——幂等（不存在/
   *  已消费静默）；作废后同 actionId 再 confirm 报「已消费」。卡片「放弃」
   *  的 daemon 侧簿记同步（消灭孤儿 actionId），零执行零回执。
   *  确认链路修复批：作废即终局——登记簿 voided（同 key 重提按新提案）+
   *  superseded 帧广播（多窗卡栈同步撤卡，G8 方向）+ 同 key 其余卡收敛。 */
  cancel(actionId: string): void {
    const entry = this.core.ledger.void(actionId);
    if (entry === undefined) return;
    // 不因删卡清 pausedGateToken：挂闸 run 若仍挂着（用户放弃的是卡不是 run），
    // 保留旗让下一个 ask 走 abort-再驱动唤醒收口（否则新 ask 误入队死等看门狗）
    this.settleProposal(entry.key ?? pendingKeyOf(entry.action), "voided", actionId, "用户放弃");
    this.core.deps.emitActionCompleted?.({
      actionId,
      ok: false,
      detail: "该操作已放弃（作废）",
      outcome: "superseded",
    });
  }

  /** 在途确认卡快照（steward.pending.snapshot 帧——订阅对账/跨重启清场；
   *  插入序；确认链路修复批，E-206 预留帧位落地）。 */
  pendingSnapshot(): readonly string[] {
    return this.core.ledger.pendingSnapshot();
  }

  /** 登记簿终局收口（批 1 起判定收编聚合——记终局 + 同 key 收敛；帧发射
   *  留翻译面：succeeded 拦重复/voided 放行重提 + 全订阅者 superseded 帧，
   *  零失效通知——治「已送达后又弹两条失效投递通知」）。 */
  settleProposal(key: string, status: "succeeded" | "voided", actionId: string, detail: string): void {
    for (const { actionId: otherId } of this.core.ledger.settle(key, status, actionId, detail)) {
      this.core.deps.emitActionCompleted?.({
        actionId: otherId,
        ok: false,
        detail: "该操作已由其它确认收敛（同内容确认卡撤除）",
        outcome: "superseded",
      });
    }
  }

  // findPendingIdByKey / latestPendingActionId 已收编 ProposalLedger 聚合
  //（domain/steward/confirmation——批 1）。

  /** 判官泛化层（M3-a）：词表未命中 ∧ pending 卡在场 → 判官三问分流。
   *  返回 undefined = 不适用/降级（原样走 LLM）；confirm/cancel = 路由
   *  执行面；revise = 撤旧卡 + 修正轮 LLM 输入（带卡全文上下文）。
   *  降级链（E-250 同款）：开关关零日志 / 端点未配 WARN / 抛错 WARN 不
   *  重试——全部回退词表后行为零劣化。无卡零判官调用（不判闲聊）。 */
  /** addressee 判定（声纹→Jev 链路批）：双工收音段的「对谁说」判定。
   *  返回 true = 高置信旁人话语（调用方回 dropped 静默丢弃）；判官缺席
   *  （undefined/关/未配）/ 灰区 / 抛错一律 false = 偏「当聊天」（置信偏置
   *  同向：宁多应答不漏应答，零配置时行为与旧版完全一致）。 */

  private async judgeAddressee(text: string): Promise<boolean> {
    // 批 3a：降级链收编 judgeOrFallback（文案逐字保留——onDegraded 形态）
    const r = await judgeOrFallback({
      judge: this.core.deps.intentJudge,
      question: STEWARD_ADDRESSEE_QUESTION,
      text,
      interpret: isAmbientSpeech,
      fallback: false, // 灰区/坏值/判官缺席一律偏「当聊天」（置信偏置：宁多应答不漏）
      onDegraded: (kind, message) => {
        if (kind === "unready") {
          this.core.deps.logger?.warn("管家意图判官开启但端点未配或已失效——addressee 判定回退当聊天（原样走 LLM）");
        } else {
          this.core.deps.logger?.warn(`addressee 判定失败，回退当聊天：${message ?? ""}`);
        }
        // 健康上报（光球角标批）：判官关闭非故障（ok 清角标）；端点失效/调
        // 用失败 = judge 降级
        if (kind === "off") this.core.deps.emitHealth?.("judge", "ok");
        else this.core.deps.emitHealth?.("judge", "degraded", message ?? kind);
      },
    });
    if (r.degraded === undefined) this.core.deps.emitHealth?.("judge", "ok"); // 判官正常 = 恢复
    return r.value;
  }

  /** stop-intent 停止判定（Jev 单轨——停止词表退役批）：停止意图判官判定面
   *  ——shell 打断链与 daemon ask 漏斗的停止判定单源（协议面
   *  steward.judge_stop_intent）。**原始判定语义**：stop=true 才判停；判不出
   *  （off/unready/error）一律 stop=false + degraded 标记，fail-stop 归消费面
   *  ——shell 意图窗判不出=真停（用户裁决②：宁误停不漏停），ask 漏斗判不出
   *  =照常走队列（不吞用户提问、不动队列序不变量）。 */
  async judgeStopIntent(text: string): Promise<{ stop: boolean; score?: number; degraded?: "off" | "unready" | "error" }> {
    // 批 3a：降级链收编 judgeOrFallback（文案逐字保留）；stop=true 才判停；
    // 判不出携 degraded 标记（原始判定面——fail-stop 归消费面）。
    const r = await judgeOrFallback<{ stop: boolean; score?: number }>({
      judge: this.core.deps.intentJudge,
      question: STEWARD_STOP_QUESTION,
      text,
      interpret: (score) => (isStopIntent(score) ? { stop: true as const, score } : { stop: false as const, score }),
      fallback: { stop: false },
      onDegraded: (kind, message) => {
        if (kind === "unready") {
          this.core.deps.logger?.warn("管家意图判官开启但端点未配或已失效——stop-intent 判不出（fail-stop 归消费面）");
        } else {
          this.core.deps.logger?.warn(`stop-intent 判定失败（判不出）：${message ?? ""}`);
        }
        if (kind === "off") this.core.deps.emitHealth?.("judge", "ok");
        else this.core.deps.emitHealth?.("judge", "degraded", message ?? kind);
      },
    });
    if (r.degraded === undefined) this.core.deps.emitHealth?.("judge", "ok");
    return r.degraded !== undefined ? { ...r.value, degraded: r.degraded } : r.value;
  }

  private async judgePendingIntent(
    text: string,
  ): Promise<
    | { intent: "confirm" | "cancel" }
    | { intent: "revise"; revisedText: string }
    | undefined
  > {
    const judge = this.core.deps.intentJudge;
    if (judge === undefined) return undefined;
    if (!judge.enabled()) return undefined; // 开关关：默认态零日志（与分诊判官同款）
    const latest = this.core.ledger.latestPendingActionId();
    if (latest === undefined) return undefined; // 无卡零判官调用（范围钳制）
    if (!judge.ready()) {
      // 开关开但端点未配/已删/非 classifier——值得提醒（用户预期判官生效）
      this.core.deps.logger?.warn("管家意图判官开启但端点未配或已失效——回退词表后行为（原样走 LLM）");
      this.core.deps.emitHealth?.("judge", "degraded", "意图判官端点未配或已失效");
      return undefined;
    }
    const entry = this.core.ledger.entryOf(latest)!;
    const state = buildIntentJudgeState(entry.action.displayTarget, entry.action.message, text);
    try {
      const [revise, cancel, confirm] = await Promise.all([
        judge.noul(state, STEWARD_INTENT_JUDGE_REVISE_QUESTION),
        judge.noul(state, STEWARD_INTENT_JUDGE_CANCEL_QUESTION),
        judge.noul(state, STEWARD_INTENT_JUDGE_CONFIRM_QUESTION),
      ]);
      const intent = pickIntentByScores(revise, cancel, confirm);
      if (intent === undefined) return undefined; // 无关新任务 → 原样走 LLM
      if (intent === "revise") {
        // 修正：撤旧卡（终局 voided + superseded 广播——多窗卡栈同步）+
        // 修正轮 LLM 输入带原卡全文（一次 LLM，不先撤卡再裸问）
        this.cancel(latest);
        return {
          intent: "revise",
          revisedText: buildIntentReviseAskText(entry.action.displayTarget, entry.action.message, text),
        };
      }
      return { intent };
    } catch (err) {
      // 判官抛错即降级不重试（E-214/E-250 同款保守语义）
      this.core.deps.logger?.warn(`管家意图判官判定失败，回退词表后行为：${(err as Error).message}`);
      this.core.deps.emitHealth?.("judge", "degraded", (err as Error).message);
      return undefined;
    }
  }

  /** 口令路由（确认链路修复批③）：纯文本口令绑定最近 pending 卡消费/作废
   *  ——零 LLM 零新提案（治「确认了很多遍」被当新指令）；无 pending 卡时
   *  返回 undefined 原样走 LLM。确认回执经广播出口（口令来自任意连接）。 */
  private routeConfirmPhrase(phrase: "confirm" | "cancel"): StewardAskResultPayload | undefined {
    const latest = this.core.ledger.latestPendingActionId();
    if (latest === undefined) return undefined;
    const entry = this.core.ledger.entryOf(latest)!;
    const target = entry.action.displayTarget;
    if (phrase === "cancel") {
      this.cancel(latest);
      return { status: "answer", text: `已放弃该操作（${target}）——卡片已撤除` };
    }
    void this
      .confirm(latest, (payload) => this.core.deps.emitActionCompleted?.(payload))
      .then((accepted) => {
        if (accepted.status !== "accepted") {
          this.host.emitLifecycleNotify(
            "normal",
            "确认未生效",
            `口令确认未受理（${accepted.status === "error" ? accepted.reason : "未知原因"}）——请点卡片确认或重试`,
          );
        }
      })
      .catch((err) => this.core.deps.logger?.warn(`口令确认异常：${(err as Error).message}`));
    // 语音闭环批 ④：confirm 受理回执 = 纯语音一句话（零额外卡/toast）——deliver
    // 卡口语化带短标题（displayTarget 已是短名），其余动词维持现回执形态。
    const confirmText =
      entry.action.kind === "deliverSession"
        ? `已确认，马上投递到「${target}」——投递结果稍后告诉你`
        : `已确认执行（${target}）——执行回执稍后送达`;
    return { status: "answer", text: confirmText };
  }

  /** 确认闸执行体（单次消费后的真实写动作；detail = 用户与 LLM 共同可见的
   *  回执文本）。B1：createSession 建成后广播 steward.navigate（sessionId
   *  执行后才产生，仍在执行体；deliverSession 的 navigate 已提前到受理时——
   *  设计稿 §3.4）。 */
  private async executePending(action: PendingAction): Promise<{ ok: boolean; detail: string }> {
    if (action.kind === "surfaceAct") {
      // M2 表面动作：确认后走同一动作管道（Registry act 路由 + seq 回执）
      const request = action.surfaceAct!;
      if (this.core.deps.surfaces === undefined) {
        return { ok: false, detail: "表面能力面未装配（daemon 装配缺 surfaces 源）" };
      }
      try {
        const result = await this.core.deps.surfaces.act(request);
        return { ok: result.ok, detail: capToolResultText(formatActReceipt(result)) };
      } catch (err) {
        return { ok: false, detail: `表面动作执行异常：${(err as Error).message}` };
      }
    }
    if (action.kind === "send") {
      const outcome = this.core.deps.orchestration.send(action.send!.agentId, action.send!.message);
      return outcome.delivered
        ? { ok: true, detail: outcome.detail }
        : { ok: false, detail: `递话未投递：${outcome.detail}` };
    }
    if (action.kind === "createSession") {
      if (this.core.deps.sessions === undefined) {
        return { ok: false, detail: "会话创建面未装配（daemon 装配缺 sessions 源）" };
      }
      try {
        // 修复批①：专用入口 createTitledSession（同轨不同入口）——title 不再
        // 被当首条用户消息发送，零引擎调用零幽灵 run；确认闸/回灌闭环不变。
        const created = await this.core.deps.sessions.createTitledSession(action.createSession!.title);
        this.core.deps.emitNavigate?.({ sessionId: created.sessionId }); // 建完即切（用户语义）
        // 带着话题开始（本次批）：建成即把 initial_message 作为首条消息投递——
        // 复用 deliver_to_session 同一执行面（idle→新轮次 / running→steer 入队；
        // source=steward 与手动输入可辨）。修复批①封堵的是「title 被误当消息」
        // 的幽灵 run，不是「用户显式给的初始话题」——两者语义正交。
        const initialMessage = action.createSession!.initialMessage;
        if (initialMessage !== undefined) {
          try {
            const outcome = await this.core.deps.sessions.deliverToSession(created.sessionId, initialMessage);
            if (!outcome.delivered) {
              // 会话已建成（主成果保留，不可重放）——投递失败如实交代，LLM
              // 回灌后可向用户说明并提议 deliver_to_session 重试。
              return {
                ok: false,
                detail: `会话已创建：${created.sessionId}「${action.createSession!.title}」，但初始话题投递失败：${outcome.detail}`,
              };
            }
            // 回合终态感知：初始话题投递成功 = 用户在新会话里开始了工作——同
            // deliverSession 语义注册关注（那边回合结束命中「回完了」分诊锚）。
            this.core.deps.onDelivered?.(created.sessionId, initialMessage);
            return {
              ok: true,
              detail: `会话已创建：${created.sessionId}「${action.createSession!.title}」，初始话题已投递：${initialMessage}`,
            };
          } catch (err) {
            return {
              ok: false,
              detail: `会话已创建：${created.sessionId}「${action.createSession!.title}」，但初始话题投递异常：${(err as Error).message}`,
            };
          }
        }
        return { ok: true, detail: `会话已创建：${created.sessionId}「${action.createSession!.title}」` };
      } catch (err) {
        return { ok: false, detail: `会话创建失败：${(err as Error).message}` };
      }
    }
    if (action.kind === "deliverSession") {
      if (this.core.deps.sessions === undefined) {
        return { ok: false, detail: "会话投递面未装配（daemon 装配缺 sessions 源）" };
      }
      try {
        const outcome = await this.core.deps.sessions.deliverToSession(action.deliverSession!.sessionId, action.deliverSession!.text);
        if (!outcome.delivered) {
          return { ok: false, detail: `投递未送达：${outcome.detail}` };
        }
        // 回合终态感知：投递成功注册关注——该会话回合结束命中分诊锚
        // （「那边回完了」主动通知；缺席 = 零关注纯 opt-in）。
        this.core.deps.onDelivered?.(action.deliverSession!.sessionId, action.deliverSession!.text);
        return { ok: true, detail: outcome.detail };
      } catch (err) {
        return { ok: false, detail: `投递执行失败：${(err as Error).message}` };
      }
    }
    // spawnReview：paramsSchema 校验在引擎（TaskError message 原样透传）
    if (this.core.deps.taskEngine === undefined) {
      return { ok: false, detail: "任务创建面未装配（daemon 装配缺 taskEngine）" };
    }
    const review = action.spawnReview!;
    try {
      const created = await this.core.deps.taskEngine.createTask({
        type: review.reviewType,
        projects: [review.project],
        params: review.params,
        createdBy: "chat",
      });
      return { ok: true, detail: `任务已创建：${created.jobId}（${review.reviewType} @ ${review.project}）` };
    } catch (err) {
      return { ok: false, detail: `任务创建被引擎拒绝：${(err as Error).message}` };
    }
  }
}
