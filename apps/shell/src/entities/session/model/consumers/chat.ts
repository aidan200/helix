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
 * - engine.retrying（P2 ⑦ 网络重试批同族）：退避等待状态卡数据，
 *   流恢复/最终失败/轮次终制即清；
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
import { isMainChannel, LOCAL_PREFIX, type ChannelItem, type SessionState } from "../state";

/** 本块承接的帧事件 type（dispatcher 注册面）。 */
export const CHAT_EVENT_TYPES = [
  "chat.stream.delta",
  "chat.message.completed",
  "chat.turn.started",
  "chat.turn.completed",
  "steer.queued",
  "steer.drained",
  "engine.error",
  "engine.retrying",
  "tool.call.started",
  "tool.call.result",
  "agent.state.changed",
] as const;

/** steer.queued：主线 echo 对账——队列坞最早未确认项换 daemon 预分配
 *  entryId（drain 落盘语义：queued 不上时间轴，对账面 = 队列坞非 entries）。
 *  定向 steer（信封 instanceId=目标）仍走 entries echo 对账（定向即时落
 *  时间轴，不经主线队列）。 */
function confirmSteerEcho(
  s: SessionState,
  entryId: string,
  instanceId?: string,
  source?: SteerSource,
): SessionState {
  // 定向分支（entries echo；契约 §3.2 Q-3a）
  if (instanceId !== undefined) {
    const idx = s.entries.findIndex(
      (e) =>
        e.kind === "message" &&
        e.id.startsWith(LOCAL_PREFIX) &&
        e.steerState === "queued" &&
        e.instanceId === instanceId,
    );
    if (idx === -1) return s; // 无 echo（他端发送等场景）：等快照对账
    const next = s.entries.slice();
    const echo = next[idx] as MessageEntryDto;
    next[idx] = { ...echo, id: entryId, ...(source !== undefined ? { source } : {}) };
    return { ...s, entries: next };
  }
  // 主线分支（队列坞 echo）
  const idx = s.steerQueue.findIndex((item) => item.id.startsWith(LOCAL_PREFIX) && !item.confirmed);
  if (idx === -1) return s; // 无 echo：等快照对账
  const next = s.steerQueue.slice();
  next[idx] = { ...next[idx]!, id: entryId, confirmed: true, ...(source !== undefined ? { source } : {}) };
  return { ...s, steerQueue: next };
}

/** steer.drained：队列坞出账（entryId 匹配移除）；entries 旧数据（旧版本落盘
 *  的 queued entry）徽标两态更新保留（快照重建前的实时兼容面）。 */
function drainSteer(s: SessionState, entryId: string, source?: SteerSource): SessionState {
  const steerQueue = s.steerQueue.some((item) => item.id === entryId)
    ? s.steerQueue.filter((item) => item.id !== entryId)
    : s.steerQueue;
  const entries = s.entries.map((e) =>
    e.kind === "message" && e.id === entryId && e.steerState === "queued"
      ? { ...e, steerState: "drained" as const, ...(source !== undefined ? { source } : {}) }
      : e,
  );
  return { ...s, steerQueue, entries };
}

export function applyChatEvent(s: SessionState, event: EventEnvelope, _ts?: number): SessionState {
  switch (event.type) {
    case "chat.stream.delta": {
      const { messageId, delta } = event.payload;
      // instanceId 分流（T10c kind 判别，缺省/主实例 id/legacy "main" = 主流）：
      // SubAgent delta 只进卡片摘要尾窗与 channel 流式槽，不进主消息流
      if (event.instanceId !== undefined && !isMainChannel(event.instanceId, s.mainInstanceId)) {
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
      // 主线 delta 到达 = 重试已成功、流恢复 → 清网络重试状态卡（P2 ⑦）；
      // T-glm-stream：正文 delta 即最近通道切 chat（GLM 同消息 thinking→正文
      // 连流，thinking.completed 迟至 message_end——phase 派生按此信号判段）
      return { ...s, streaming, engineRetrying: null, lastStreamKind: "chat" };
    }
    case "chat.message.completed": {
      const entry = event.payload.entry;
      // SubAgent 消息不进主消息流（F1.6，kind 判别）：定稿卡片摘要 + 入实例 channel
      // （user 消息 = 主线 agent_send 转投回放 → steer 注入标记；F1.2）
      const iid = event.instanceId ?? entry.instanceId;
      if (iid !== undefined && !isMainChannel(iid, s.mainInstanceId)) {
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
      // 新轮开始：清上一轮的引擎错误卡（瞬态语义，终验热修）+ 网络重试卡（P2 ⑦）
      // currentTurnId 记录：后台未读游标对账锚（demote 时入 background.seen.turnId）
      return { ...s, engineError: null, engineRetrying: null, currentTurnId: event.payload.turnId };
    case "chat.turn.completed":
      return { ...s, streaming: null, engineRetrying: null, currentTurnId: null };
    case "steer.queued": {
      // 定向帧（T2.3：信封 instanceId=目标）只认同目标 echo；缺省/主实例 id
      //（kind 判别）= 主线 echo（队列坞对账）
      const iid = event.instanceId;
      return confirmSteerEcho(
        s,
        event.payload.entryId,
        iid !== undefined && !isMainChannel(iid, s.mainInstanceId) ? iid : undefined,
        event.payload.source,
      );
    }
    case "steer.drained":
      return drainSteer(s, event.payload.entryId, event.payload.source);
    // 终验热修：引擎/模型调用失败 → 错误卡片数据（provider 原文透传；
    // 随后的 turn.completed 收流，新 turn.started 清除——瞬态不落盘）
    case "engine.error":
      // P2 ⑦：最终失败换错误卡，重试状态卡同时收（两卡不叠加）
      return { ...s, engineError: { message: event.payload.message }, engineRetrying: null };
    // P2 ⑦ 网络重试批：LLM 瞬时失败退避等待可见反馈（状态卡数据；
    // 流恢复/最终失败/轮次终制清除——瞬态不落盘，快照重建天然归零）
    case "engine.retrying":
      return {
        ...s,
        engineRetrying: {
          attempt: event.payload.attempt,
          totalAttempts: event.payload.totalAttempts,
          waitMs: event.payload.waitMs,
          message: event.payload.message,
        },
      };
    case "tool.call.started":
    case "tool.call.result": {
      const entry = event.payload.entry;
      // SubAgent 内部工具调用只进 per-instance channel，不进主线事件流（F1.6，kind 判别）
      const iid = event.instanceId ?? entry.instanceId;
      if (iid !== undefined && !isMainChannel(iid, s.mainInstanceId)) {
        if (entry.kind !== "tool-call") return s;
        return upsertChannelEntry(s, iid, entry);
      }
      return { ...s, entries: upsertEntry(s.entries, entry) };
    }
    case "agent.state.changed": {
      const agentState = event.payload.state;
      // idle 收流式态 + 网络重试卡（run 终结——含 abort 打断等待的场景）
      return {
        ...s,
        agentState,
        streaming: agentState === "idle" ? null : s.streaming,
        engineRetrying: agentState === "idle" ? null : s.engineRetrying,
      };
    }
    default:
      return s;
  }
}
