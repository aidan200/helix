/**
 * instance-history 消费者 —— session.instanceChannels.result（channels
 * 惰性化批）：SubAgent 实例通道历史按需拉取回填。
 *
 * 快照只携带每通道预览条（SNAPSHOT_CHANNEL_PREVIEW）；抽屉打开实例时
 * 发 session.instanceChannels 拉首页，本消费者把三槽全量归并打平，
 * 重建该实例的完整 channel 列表（spawned 头 + modelResolved + 全量条目
 * + closure 尾卡——与快照 channelsFromSnapshot 同构，seq 重新编号）。
 *
 * 替换语义（非合并）：预览条目/快照重建列表被全量替换；增量流式帧
 * （channelStreams/chat consumers）继续在其上叠加——回填发生在抽屉
 * 打开瞬间，运行中实例的流式帧到达序天然晚于回填，无覆盖竞态。
 * 纯函数纪律（AG-14）：无 React / 无 IO / 无 Date.now。
 */
import type { EventEnvelope } from "@helix/protocol";
import type { SessionState } from "../state";
import { lcItem } from "../channel";
import { entryToChannelItem } from "./snapshot";
import type { ChannelItem } from "../state";

/** 本块承接的帧事件 type（dispatcher 注册面）。 */
export const INSTANCE_HISTORY_EVENT_TYPES = ["session.instanceChannels.result"] as const;

export function applyInstanceHistoryEvent(s: SessionState, event: EventEnvelope): SessionState {
  if (event.type !== "session.instanceChannels.result") return s;
  const { instanceId, channels } = event.payload;
  const card = s.instances.find((c) => c.instanceId === instanceId);
  // 未知实例（实例卡已退场/竞态）：原样返回不建空 channel
  if (card === undefined) return s;
  // 三槽归并打平（升序，与快照 groupedChannelItems 同口径）
  const merged = [
    ...(channels.messages ?? []),
    ...(channels.tools ?? []),
    ...(channels.thinking ?? []),
  ].sort((a, b) => entrySortKeyOf(a) - entrySortKeyOf(b));
  const items: ChannelItem[] = [
    lcItem("spawned")(1),
    lcItem("modelResolved", {
      model: card.model ?? s.model,
      slot: card.model !== undefined ? "declared" : "inherited",
    })(2),
  ];
  let seq = 3;
  for (const e of merged) {
    const item = entryToChannelItem(e, seq++);
    if (item) items.push(item);
  }
  if (card.closure) items.push({ kind: "closure", seq, closure: card.closure });
  return {
    ...s,
    instanceChannels: { ...s.instanceChannels, [instanceId]: items },
  };
}

// 排序基元单源（projection re-export 同构；snapshot.ts 同款本地别名）
import { entrySortKey as entrySortKeyOf } from "@helix/protocol";
