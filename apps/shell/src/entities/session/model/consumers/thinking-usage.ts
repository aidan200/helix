/**
 * thinking·usage 消费者 —— v0.1 通道族（thinking 流/完成 + compaction 里程碑 +
 * usage 账目，四 case；C2 拆分，AD-3，T1.1；契约 §5.2）。
 *
 * - thinking 流式中间态不落盘（TR-AD-5）：按 instanceId 累积，completed 落
 *   Entry（complete 不可逆）并清该实例槽位；F1.6 分流：SubAgent thinking 只
 *   进实例 channel（抽屉折叠块），不进主消息流；
 * - compaction.completed 是里程碑条数据源（entry.usage 为展示面）；账目入账
 *   唯一驱动 = usage.recorded / 快照——此处特意不再累加（AD-9③ 双计防线）；
 * - usage.recorded 聚合：turn 源 → per-instance 小计；compaction 源 →
 *   compaction 小计（不进实例小计）；流式中冻结由「delta 分支不触碰 usage」
 *   结构性保证。
 */
import type { EventEnvelope, UsageDto } from "@helix/protocol";
import { upsertChannelEntry } from "../channel";
import { upsertEntry } from "../entries";
import { MAIN_INSTANCE_ID, ZERO_USAGE, type SessionState } from "../state";

/** 本块承接的帧事件 type（dispatcher 注册面）。 */
export const THINKING_USAGE_EVENT_TYPES = [
  "thinking.stream.delta",
  "thinking.completed",
  "compaction.completed",
  "usage.recorded",
] as const;

/** UsageDto 逐字段累加（账目聚合；永远产生新对象）。 */
function addUsage(a: UsageDto, b: UsageDto): UsageDto {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: a.cost + b.cost,
  };
}

export function applyThinkingUsageEvent(
  s: SessionState,
  event: EventEnvelope,
  _ts?: number,
): SessionState {
  switch (event.type) {
    case "thinking.stream.delta": {
      // thinking 流式中间态不落盘（TR-AD-5）：按 instanceId 累积；渲染归 T4.2
      const { instanceId, delta } = event.payload;
      const prev = s.thinkingStreams[instanceId] ?? "";
      return { ...s, thinkingStreams: { ...s.thinkingStreams, [instanceId]: prev + delta } };
    }
    case "thinking.completed": {
      // 完成落 Entry（complete-collapsed 不可逆）；流式槽位随实例清空（他实例不受扰）；
      // F1.6 分流：SubAgent thinking 只进实例 channel（抽屉折叠块），不进主消息流
      const entry = event.payload.entry;
      const streams = { ...s.thinkingStreams };
      delete streams[entry.instanceId];
      const cleared: SessionState = { ...s, thinkingStreams: streams };
      if (entry.instanceId !== MAIN_INSTANCE_ID) {
        return upsertChannelEntry(cleared, entry.instanceId, entry);
      }
      return { ...cleared, entries: upsertEntry(cleared.entries, entry) };
    }
    case "compaction.completed":
      // 里程碑条数据源（entry.usage 为展示面）；账目入账唯一驱动 = usage.recorded/
      // 快照——若此处再累加将与 usage.recorded(source=compaction) 双计（AD-9③防线）
      return { ...s, entries: upsertEntry(s.entries, event.payload.entry) };
    case "usage.recorded": {
      // 账目聚合（流式中冻结由「delta 分支不触碰 usage」结构性保证）：
      // turn 源 → per-instance 小计；compaction 源 → compaction 小计（不进实例
      // 小计，total = Σ实例 + compaction 与 popover 行自洽，原型 INSTANCES 口径）
      const { instanceId, usage: u, source } = event.payload;
      const byInstance = { ...s.usage.byInstance };
      if (source === "turn") {
        byInstance[instanceId] = addUsage(byInstance[instanceId] ?? ZERO_USAGE, u);
      }
      return {
        ...s,
        usage: {
          total: addUsage(s.usage.total, u),
          compaction: source === "compaction" ? addUsage(s.usage.compaction, u) : s.usage.compaction,
          byInstance,
        },
      };
    }
    default:
      return s;
  }
}
