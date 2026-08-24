/**
 * chat 消费者 —— 消息流 + steer 对账 + 引擎错误 + 工具卡（C2 拆分，AD-3，T1.1）。
 *
 * 承接 10 case（承接面定稿，写入模块头）：
 * - chat.stream.delta / chat.message.completed / chat.turn.started /
 *   chat.turn.completed：主线消息流与流式中间态；一帧三槽（streaming /
 *   channelStreams / instances 摘要尾窗）与 instanceId 分流（缺省 = main）；
 * - steer.queued / steer.drained：本地 echo 对账（LOCAL_PREFIX + daemon
 *   entryId 确认）与徽标两态（SM-3）；
 * - engine.error（终验热修族归 chat）：错误卡片数据，瞬态不落盘——
 *   chat.turn.started 清除、turn.completed 收流时序由本族内闭环；
 * - tool.call.started / tool.call.result：主线工具卡三态（SM-4）；SubAgent
 *   工具只进 per-instance channel（F1.6 分流）；
 * - agent.state.changed：主线会话运行态（idle 清流式收口）——非 SubAgent
 *   编排族（agent.* 七 case 归 agent 消费者），按主线会话语义归本块定稿。
 *
 * SubAgent delta 只更新卡片摘要尾窗与 channel 流式槽，不进主消息流。
 */
import type { EntryDto, EventEnvelope, MessageEntryDto, SteerSource } from "@helix/protocol";
import { channelOf, upsertChannelEntry } from "../channel";
import { appendSummary, finalizeSummary } from "../instance-cards";
import { upsertEntry } from "../entries";
import { LOCAL_PREFIX, MAIN_INSTANCE_ID, type ChannelItem, type SessionState } from "../state";

/** 本块承接的帧事件 type（dispatcher 注册面）。 */
export const CHAT_EVENT_TYPES = [
  "chat.stream.delta",
  "chat.message.completed",
  "chat.turn.started",
  "chat.turn.completed",
  "steer.queued",
  "steer.drained",
  "engine.error",
  "tool.call.started",
  "tool.call.result",
  "agent.state.changed",
] as const;

/** steer.queued：把最早的未确认本地 echo 换成 daemon entryId（确认对账）。
 *  v0.3（CL-3 契约 §3.2）：定向 steer 帧信封挂 instanceId=目标——echo 匹配
 *  限定同目标（缺省/main 帧只认无 instanceId 的主线 echo，防并发 echo 错位）。 */
function confirmSteerEcho(entries: EntryDto[], entryId: string, instanceId?: string, source?: SteerSource): EntryDto[] {
  const idx = entries.findIndex(
    (e) =>
      e.kind === "message" &&
      e.id.startsWith(LOCAL_PREFIX) &&
      e.steerState === "queued" &&
      (instanceId === undefined ? e.instanceId === undefined : e.instanceId === instanceId),
  );
  if (idx === -1) return entries; // 无 echo（他端发送等场景）：等快照对账
  const next = entries.slice();
  const echo = next[idx] as MessageEntryDto;
  // source 透传（T11b：closure/progress 徽标变体依据；缺省不携带键 = 老事件按 user）
  next[idx] = { ...echo, id: entryId, ...(source !== undefined ? { source } : {}) };
  return next;
}

/** steer.drained：徽标 queued → drained（SM-3 第二态）；source 同源更新（T11b）。 */
function drainSteer(entries: EntryDto[], entryId: string, source?: SteerSource): EntryDto[] {
  return entries.map((e) =>
    e.kind === "message" && e.id === entryId && e.steerState === "queued"
      ? { ...e, steerState: "drained" as const, ...(source !== undefined ? { source } : {}) }
      : e,
  );
}

export function applyChatEvent(s: SessionState, event: EventEnvelope, _ts?: number): SessionState {
  switch (event.type) {
    case "chat.stream.delta": {
      const { messageId, delta } = event.payload;
      // instanceId 分流（缺省 = main）：SubAgent delta 只进卡片摘要尾窗与 channel 流式槽，不进主消息流
      if (event.instanceId !== undefined && event.instanceId !== MAIN_INSTANCE_ID) {
        const iid = event.instanceId;
        const prev = s.channelStreams[iid];
        const stream =
          prev && prev.messageId === messageId
            ? { messageId, text: prev.text + delta }
            : { messageId, text: delta };
        return {
          ...s,
          instances: appendSummary(s.instances, iid, delta),
          channelStreams: { ...s.channelStreams, [iid]: stream },
        };
      }
      const streaming =
        s.streaming && s.streaming.messageId === messageId
          ? { messageId, text: s.streaming.text + delta }
          : { messageId, text: delta };
      return { ...s, streaming };
    }
    case "chat.message.completed": {
      const entry = event.payload.entry;
      // SubAgent 消息不进主消息流（F1.6）：定稿卡片摘要 + 入实例 channel
      // （user 消息 = 主线 agent_send 转投回放 → steer 注入标记；F1.2）
      const iid = event.instanceId ?? entry.instanceId;
      if (iid !== undefined && iid !== MAIN_INSTANCE_ID) {
        if (entry.kind !== "message") return s;
        const streams = { ...s.channelStreams };
        delete streams[iid];
        const item: ChannelItem =
          entry.role === "user"
            ? entry.steerState !== undefined
              ? // 定向 steer 干预条目（CL-3，契约 §3.2 Q-3a 抽屉侧投影激活——
                // user+isSteer 且 instanceId=目标）：与主线 agent_send 转投回放
                //（普通 user，无 steerState）分物种
                { kind: "steer-directed", seq: s.nextChannelSeq, text: entry.content, ts: entry.ts, target: iid }
              : { kind: "steer", seq: s.nextChannelSeq, text: entry.content, ts: entry.ts }
            : { kind: "message", seq: s.nextChannelSeq, text: entry.content, ts: entry.ts };
        return {
          ...s,
          instances: finalizeSummary(s.instances, iid, entry.content),
          channelStreams: streams,
          nextChannelSeq: s.nextChannelSeq + 1,
          instanceChannels: {
            ...s.instanceChannels,
            [iid]: [...channelOf(s.instanceChannels, iid), item],
          },
        };
      }
      const cleared =
        entry.kind === "message" && entry.role === "assistant" ? null : s.streaming;
      return { ...s, entries: upsertEntry(s.entries, entry), streaming: cleared };
    }
    case "chat.turn.started":
      // 新轮开始：清上一轮的引擎错误卡（瞬态语义，终验热修）
      return { ...s, engineError: null }; // 轮次里程碑（v0 无 UI 投影面）
    case "chat.turn.completed":
      return { ...s, streaming: null };
    case "steer.queued": {
      // 定向帧（T2.3：信封 instanceId=目标）只认同目标 echo；缺省 = 主线 echo
      const iid = event.instanceId;
      return {
        ...s,
        entries: confirmSteerEcho(
          s.entries,
          event.payload.entryId,
          iid !== undefined && iid !== MAIN_INSTANCE_ID ? iid : undefined,
          event.payload.source,
        ),
      };
    }
    case "steer.drained":
      return { ...s, entries: drainSteer(s.entries, event.payload.entryId, event.payload.source) };
    // 终验热修：引擎/模型调用失败 → 错误卡片数据（provider 原文透传；
    // 随后的 turn.completed 收流，新 turn.started 清除——瞬态不落盘）
    case "engine.error":
      return { ...s, engineError: { message: event.payload.message } };
    case "tool.call.started":
    case "tool.call.result": {
      const entry = event.payload.entry;
      // SubAgent 内部工具调用只进 per-instance channel，不进主线事件流（F1.6）
      const iid = event.instanceId ?? entry.instanceId;
      if (iid !== undefined && iid !== MAIN_INSTANCE_ID) {
        if (entry.kind !== "tool-call") return s;
        return upsertChannelEntry(s, iid, entry);
      }
      return { ...s, entries: upsertEntry(s.entries, entry) };
    }
    case "agent.state.changed": {
      const agentState = event.payload.state;
      return { ...s, agentState, streaming: agentState === "idle" ? null : s.streaming };
    }
    default:
      return s;
  }
}
