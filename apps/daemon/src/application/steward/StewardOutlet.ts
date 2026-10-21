/**
 * StewardOutlet —— 管家播报编排域（体量门 P4：自 StewardService 迁出）。
 *
 * 职责（出口帧编排）：feed 播报闸与帧组装（①层粗筛 + 订阅闸 + seq）、
 * 生命周期提醒帧（挂起/可达性/TTL 作废）、主动汇报实时帧与工作记忆同源
 * 追加、ask 过程流式回执（工具/thinking/文本增量）转发。
 *
 * 纪律面：只产出协议帧，零领域事件发布（防自激——TR-169/TR-173 族）；
 * 订阅闸/限流/去重在 EventStream 侧（本域缺席出口 = 零帧零降级）。
 * 行为零变更：方法体自 StewardService 逐段搬运，仅把 `this.<共享状态>`
 * 改写为 `this.core.<共享状态>`。
 */
import type { DomainEvent } from "../../domain/events/DomainEvent";
import type { AgentEngineEvent } from "../ports/outbound/AgentEnginePort";
import type { StewardFeedPayload } from "@helix/protocol";
import { STEWARD_FEED_EVENT_TYPES, buildFeedText } from "./stewardFeed";
import { summarizeArgsLite } from "./stewardProjections";
import type { StewardCore } from "./StewardCore";

export class StewardOutlet {
  private readonly core: StewardCore;

  constructor(core: StewardCore) {
    this.core = core;
  }

  /**
   * fanout 目标入口（wireEventFanout steward-feed-bridge 装配）：①层粗筛 +
   * 闸门 + ②层模板直出 + feed 帧。只产出协议帧，零领域事件发布（防自激）。
   */
  onDomainEvent(event: DomainEvent): void {
    if (!STEWARD_FEED_EVENT_TYPES.has(event.type)) return;
    if (!this.core.deps.feedGate.hasStewardSubscribers()) return; // 零订阅零推送
    const text = buildFeedText(event);
    if (text === undefined) return;
    const payload = event.payload as { agentId?: string };
    if (typeof payload.agentId !== "string" || payload.agentId === "") return;
    this.core.feedSeq += 1;
    this.core.deps.emitFeed({
      kind: event.type as StewardFeedPayload["kind"],
      agentId: payload.agentId,
      text,
      seq: this.core.feedSeq,
    });
  }
  /** 可靠性提醒帧出口（seq 单调；订阅闸/限流在 EventStream 侧——缺席零提醒）。 */
  /** 可靠性提醒帧出口（seq 单调；订阅闸/限流在 EventStream 侧——缺席零提醒）。 */
  emitLifecycleNotify(urgency: "normal" | "high", title: string, body: string): void {
    if (this.core.deps.emitNotify === undefined) return;
    this.core.notifySeq += 1;
    this.core.deps.emitNotify({ urgency, title, body, seq: this.core.notifySeq });
  }
  /**
   * 对话内主动汇报（M0.5-R：激活态主动环投递面，D12-⑫「激活=对话内主动
   * 汇报+接续提案」）：分诊呈现轨 + 接续提案以 assistant 记录入工作记忆
   * ——同源链路保持（UI 对话回放显示的 = LLM 记得的，后续 ask 自带已汇报
   * 现场）；只是记录追加，零引擎驱动零响应环改动；接续提案为文本建议行，
   * 点按才动/写类动作仍过确认闸（D12-⑤ 不变）。组合根接
   * StewardPerceptionService.reportDialog 窄接口。
   *
   * M3-a（CAND-601 闭环）：记录追加的同时广播 steward.proactive 实时帧
   * ——开着的面板实时冒出汇报条目（不重开面板）；重开面板由 history 回放
   * 同源再现。emitProactive 缺席 = 零帧，记录照写（语义面零降级）。
   */
  async reportProactive(report: { title: string; text: string; suggestions?: readonly { label: string; verb?: string; sessionId?: string }[] }): Promise<void> {
    const lines = [`【主动汇报】${report.title}`, report.text];
    for (const s of report.suggestions ?? []) {
      if (s.label.trim() !== "") lines.push(`建议：${s.label}（点按才动）`);
    }
    await this.core.pushRecord({ kind: "assistant", text: lines.join("\n"), at: this.core.now() });
    this.core.proactiveSeq += 1;
    this.core.deps.emitProactive?.({
      title: report.title,
      text: report.text,
      ...(report.suggestions !== undefined && report.suggestions.length > 0 ? { suggestions: report.suggestions } : {}),
      seq: this.core.proactiveSeq,
    });
  }
  /** ask 流式回调转发（message_update/thinking/tool_execution → events 面
   *  ——签名对齐 StewardAskEvents：argsSummary/resultSummary 以事件面可得字段派生）。
   *  事故热修批⑥：thinking 帧不再由 thinking_delta 直通——pi 的 thinking_delta
   *  是 token 级增量事件，而 onThinking 契约是段级（一个完成态块一帧全量，
   *  StewardLlmPort 头注释同源）；直通 = 每 delta 一帧 → shell 每帧一条目 =
   *  「按字一行」事故形态。改为 message_end 完成块聚合发帧（与 KV 投影
   *  thinkingBlocks 同源同文本）。 */
  forwardStreamCallbacks(event: AgentEngineEvent): void {
    const ev = this.core.askStreamEvents;
    if (ev.onDelta !== undefined && event.type === "message_update") {
      ev.onDelta(event.delta);
    } else if (ev.onThinking !== undefined && event.type === "message_end" && event.role !== "user" && event.role !== "toolResult") {
      const thinkingBlocks = (event.blocks ?? []).filter(
        (b): b is Extract<typeof b, { type: "thinking" }> => b.type === "thinking",
      );
      const thinkingText = thinkingBlocks.map((b) => b.text).join("\n");
      if (thinkingText !== "") ev.onThinking(thinkingText);
    } else if (ev.onToolStart !== undefined && event.type === "tool_execution_start") {
      ev.onToolStart(event.toolName, summarizeArgsLite(event.args));
    } else if (ev.onToolEnd !== undefined && event.type === "tool_execution_end") {
      ev.onToolEnd(event.toolName, event.isError === true ? "（执行失败）" : event.result.slice(0, 120));
    }
  }
}
