/**
 * thinking·usage 消费者 —— v0.1 通道族（thinking 流/完成 + compaction 里程碑 +
 * usage 账目，四 case；C2 拆分，AD-3，T1.1；契约 §5.2）。
 *
 * - thinking 流式中间态不落盘（TR-AD-5）：按 instanceId 累积，completed 落
 *   Entry（complete 不可逆）并清该实例槽位；F1.6 分流：SubAgent thinking 只
 *   进实例 channel（抽屉折叠块），不进主消息流；
 * - compaction.completed 是里程碑条数据源（entry.usage 为展示面）；账目入账
 *   唯一驱动 = usage.recorded / 快照——此处特意不再累加（AD-9③ 双计防线）；
 * - usage.recorded 聚合（T3.1 口径统一，AF-2）：turn/compaction 源均计入
 *   per-instance 小计（与 daemon UsageLedger 同口径，AD-9③）；compaction 源
 *   另计独立小计；total = Σ实例（含 compaction 贡献）；流式中冻结由
 *   「delta 分支不触碰 usage」结构性保证。累加基元单源
 *   @helix/protocol projection（addUsage/ZERO_USAGE，原本地副本退役）。
 */
import type { EventEnvelope } from "@helix/protocol";
import { addUsage } from "@helix/protocol";
import { upsertChannelEntry } from "../channel";
import { upsertEntry } from "../entries";
import { isMainChannel, ZERO_USAGE, type SessionState } from "../state";

/** 本块承接的帧事件 type（dispatcher 注册面）。 */
export const THINKING_USAGE_EVENT_TYPES = [
  "thinking.stream.delta",
  "thinking.completed",
  "compaction.completed",
  "usage.recorded",
] as const;

export function applyThinkingUsageEvent(
  s: SessionState,
  event: EventEnvelope,
  _ts?: number,
): SessionState {
  switch (event.type) {
    case "thinking.stream.delta": {
      // thinking 流式中间态不落盘（TR-AD-5）：按 instanceId 累积；渲染归 T4.2
      // R5 键翻译：wire 主实例归一 “main”/缺省（EventStream T10d）→ state 槽位键
      // 归一回快照习得主实例 id（T10a hex）——渲染读键 = state.mainInstanceId，
      // 同构 chat.stream.delta 的 isMainChannel 分流判别；subagent hex 直通
      const { instanceId, delta } = event.payload;
      const key = isMainChannel(instanceId, s.mainInstanceId) ? s.mainInstanceId : instanceId;
      const prev = s.thinkingStreams[key] ?? "";
      // T-glm-stream：主槽 delta 即最近通道切 thinking（交错流回段重亮；
      // 判定面 selectWorkPhase，槽位生命周期不变——completed 照常清槽）
      return {
        ...s,
        thinkingStreams: { ...s.thinkingStreams, [key]: prev + delta },
        ...(isMainChannel(instanceId, s.mainInstanceId) ? { lastStreamKind: "thinking" as const } : {}),
      };
    }
    case "thinking.completed": {
      // 完成落 Entry（complete-collapsed 不可逆）；流式槽位随实例清空（他实例不受扰）；
      // F1.6 分流（kind 判别）：SubAgent thinking 只进实例 channel（抽屉折叠块），不进主消息流
      // R5 键翻译同 delta 分支：entry.instanceId wire 归一 “main” → 清除键归一回 hex
      const entry = event.payload.entry;
      const streams = { ...s.thinkingStreams };
      delete streams[isMainChannel(entry.instanceId, s.mainInstanceId) ? s.mainInstanceId : entry.instanceId];
      const cleared: SessionState = { ...s, thinkingStreams: streams };
      if (!isMainChannel(entry.instanceId, s.mainInstanceId)) {
        return upsertChannelEntry(cleared, entry.instanceId, entry);
      }
      return { ...cleared, entries: upsertEntry(cleared.entries, entry) };
    }
    case "compaction.completed":
      // 里程碑条数据源（entry.usage 为展示面）；账目入账唯一驱动 = usage.recorded/
      // 快照——若此处再累加将与 usage.recorded(source=compaction) 双计（AD-9③防线）。
      // 上下文水位归位：压缩后上下文 = tokensAfter（estimateContextTokens 复算值），
      // 覆盖 main 实例旧水位（entry.instanceId wire 归一 “main”→状态主实例键，同 delta 分支）
      return {
        ...s,
        entries: upsertEntry(s.entries, event.payload.entry),
        usage: {
          ...s.usage,
          ctxByInstance: {
            ...s.usage.ctxByInstance,
            [isMainChannel(event.payload.entry.instanceId, s.mainInstanceId)
              ? s.mainInstanceId
              : event.payload.entry.instanceId]: event.payload.entry.tokensAfter,
          },
        },
      };
    case "usage.recorded": {
      // 账目聚合（流式中冻结由「delta 分支不触碰 usage」结构性保证）：
      // 【口径统一修正，AF-2/T3.1】turn/compaction 源均计入 per-instance 小计
      //（compaction 归属 main 实例执行——对齐 daemon UsageLedger，AD-9③）；
      // compaction 源另计独立小计；total = Σ实例（含 compaction 贡献，与
      // daemon 快照面数值一致——同一 store 增量/快照两路径口径自此统一）
      const { instanceId, usage: u, source } = event.payload;
      // 上下文水位（非账目）：source=turn 时最近一次 LLM 调用的 totalTokens
      //（input+cache R/W+output，provider 实测）≈ 该实例当前上下文占用；
      // source=compaction 不覆盖（摘要调用 input 是压缩前全文——compaction.completed
      // 的 tokensAfter 才是压缩后水位，两事件到达序无关）
      const ctxByInstance =
        source === "turn"
          ? { ...s.usage.ctxByInstance, [instanceId]: u.totalTokens }
          : s.usage.ctxByInstance;
      return {
        ...s,
        usage: {
          total: addUsage(s.usage.total, u),
          compaction: source === "compaction" ? addUsage(s.usage.compaction, u) : s.usage.compaction,
          byInstance: {
            ...s.usage.byInstance,
            [instanceId]: addUsage(s.usage.byInstance[instanceId] ?? ZERO_USAGE, u),
          },
          ctxByInstance,
        },
      };
    }
    default:
      return s;
  }
}
