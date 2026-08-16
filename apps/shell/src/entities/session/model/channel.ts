/**
 * entities/session —— per-instance channel 时间线工具（C2 拆分共享面，T1.1）。
 *
 * P-2 抽屉单一时间线（ChannelItem 五物种）读写工具集：agent 消费者
 * （lifecycle 行 / closure 卡）、chat 消费者（SubAgent 消息 / 工具定稿）、
 * thinking·usage 消费者（thinking 定稿块）、snapshot 消费者（快照重建）
 * 共用，自原 session-reducer.ts 语义不变迁出。seq 单调递增（React key /
 * 到达序）；nextChannelSeq 全局单调语义保持现状（跨实例 seq 归 T3.1 决策）。
 */
import type { ThinkingEntryDto, ToolCallEntryDto } from "@helix/protocol";
import type { ChannelItem, ChannelLcKey, SessionState } from "./state";

/** channel 槽位读取（乱序容错：未建槽位实例视作空时间线）。 */
export function channelOf(channels: Record<string, ChannelItem[]>, iid: string): ChannelItem[] {
  return channels[iid] ?? [];
}

/** 追加条目（next() 分配单调 seq；不可变更新）。 */
export function withChannel(
  s: SessionState,
  iid: string,
  build: (next: () => number) => ChannelItem[],
): SessionState {
  let seq = s.nextChannelSeq;
  const next = () => seq++;
  const items = build(next);
  return {
    ...s,
    nextChannelSeq: seq,
    instanceChannels: {
      ...s.instanceChannels,
      [iid]: [...channelOf(s.instanceChannels, iid), ...items],
    },
  };
}

/** channel 内按 entry.id 原位替换（工具/思考定稿保位；seq 稳定 = React key 稳定）。 */
export function upsertChannelEntry(
  s: SessionState,
  iid: string,
  entry: ToolCallEntryDto | ThinkingEntryDto,
): SessionState {
  const existing = channelOf(s.instanceChannels, iid);
  const isTool = entry.kind === "tool-call";
  const idx = existing.findIndex((i) =>
    isTool ? i.kind === "tool" && i.entry.id === entry.id : i.kind === "thinking-entry" && i.entry.id === entry.id,
  );
  if (idx === -1) {
    const item: ChannelItem = isTool
      ? { kind: "tool", seq: s.nextChannelSeq, entry }
      : { kind: "thinking-entry", seq: s.nextChannelSeq, entry };
    return {
      ...s,
      nextChannelSeq: s.nextChannelSeq + 1,
      instanceChannels: { ...s.instanceChannels, [iid]: [...existing, item] },
    };
  }
  const nextItems = existing.slice();
  const prev = nextItems[idx]!;
  nextItems[idx] =
    prev.kind === "tool" && isTool
      ? { ...prev, entry: entry as ToolCallEntryDto }
      : prev.kind === "thinking-entry" && !isTool
        ? { ...prev, entry: entry as ThinkingEntryDto }
        : prev;
  return { ...s, instanceChannels: { ...s.instanceChannels, [iid]: nextItems } };
}

/** lifecycle 行工厂（tone 由键派生：stalled=warn / crashed·terminated=err）。 */
export function lcItem(
  lc: ChannelLcKey,
  extra: Partial<{ ts: number; model: string; slot: "declared" | "inherited"; idleMs: number; error: string }> = {},
): (seq: number) => ChannelItem {
  const tone: "info" | "warn" | "err" =
    lc === "stalled" ? "warn" : lc === "crashed" || lc === "terminated" ? "err" : "info";
  return (seq) => ({ kind: "lifecycle", seq, lc, tone, ...extra });
}
