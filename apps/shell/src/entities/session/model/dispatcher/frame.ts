/**
 * dispatcher 帧入口 —— v0.2 统一信封路由（AD-3 §3.4 前端形态 / AD-4 会话
 * 路由位；契约 A §1.2；T3.1 接线）。
 *
 * dispatchFrame（纯函数）：帧 → 解析信封（sessionId/channel/type）→ 按
 * sessionId 路由 → 按 type 交消费者：
 *
 * ⓪ 拓扑级模型/厂商配置族（model/auth 9 类 *.result）→ modelConfig 面
 *    ——先于后台路由：model.get.result 等结果帧信封 sid=目标会话，草稿态
 *    （activeId=null）下若先过后台守卫会被误吞进后台路径；拓扑级消费提前安全；
 * ① 后台会话帧（信封 sessionId 命中后台轻量 store）→ 轻量消费（运行态徽标
 *    投影 + 未读计数；不渲染 entries）——活跃完整 store 引用保持不变；
 *    路由不依赖 activeId 非空（草稿态 activeId 可为 null——bug3 修复：
 *    旧守卫「activeId!==null」让草稿态下旧会话流式帧绕过后台路由直落
 *    活跃草稿 store，串台）；session.snapshot 除外（见②）：快照是连接级
 *    重建指令，目标会话转活跃；
 * ② 系统帧（sessionId = SYSTEM_SESSION_ID / 缺省——v0/v0.1 兼容单会话语义，
 *    仅覆盖**无信封 sessionId** 的帧落活跃 / session.snapshot）→ 清单族
 *    （directory 拓扑级消费者）→ 活跃完整 store 消费者注册表（五族 +
 *    model/history）；
 * ③ 未知会话帧（既非活跃也非后台）→ 原样丢弃（多会话隔离，不误写活跃 store）。
 *
 * session.snapshot 应用后清理 background 同名轻量态（草稿建会话链：
 * list_changed{created} 先播种轻量 store，快照到达转活跃——残留即双源）。
 * channel 为类型学登记（族分组），路由权威 = 信封 sessionId（契约 A §1.2）。
 * 纯函数纪律（AG-14）：无 React / 无 IO / 无 Date.now。
 */
import { SYSTEM_SESSION_ID } from "@helix/protocol";
import type { ChatMessageCompletedPayload, ChatTurnStartedPayload, EventEnvelope } from "@helix/protocol";
import type { BackgroundSessionState, TopologyState } from "../state";
import { applyDirectoryEvent, isDirectoryEventType } from "../consumers/directory";
import {
  applyModelConfigEvent,
  isModelConfigEventType,
} from "../consumers/model-config";
import {
  applyAgentConfigEvent,
  isAgentConfigEventType,
} from "../consumers/agent-config";
import { applyWebEvent, isWebEventType } from "../consumers/web-status";
import { route } from "./index";

/** v0.2 统一信封帧入口：拓扑状态 + 事件帧 → 新拓扑状态。 */
export function dispatchFrame(topo: TopologyState, frame: EventEnvelope, ts?: number): TopologyState {
  const sid = frame.sessionId;
  const activeId = topo.active.sessionId;
  // ⓪ 拓扑级模型/厂商配置族（model/auth 9 类 *.result；T3.3 前置——含
  //    model.get.result（信封 sessionId=目标会话）。先于后台路由：草稿态
  //    （activeId=null）下结果帧若先过后台守卫会被误吞进后台路径；model 配置
  //    族是拓扑级消费，提前安全；全局数据不入会话 store）
  if (isModelConfigEventType(frame.type)) {
    return applyModelConfigEvent(topo, frame);
  }
  // ⓪′ 拓扑级 agent.config 配置族（v0.6，M6 T4 真消费）：changed 广播 →
  //    agentConfig.revision 失效重拉信号；两结果帧拓扑级直通（真消费归页面
  //    查询链，SessionContext 转发层）——先于后台/系统路由的拓扑级消费
  //    （model 族两层拓扑同构）
  if (isAgentConfigEventType(frame.type)) {
    return applyAgentConfigEvent(topo, frame);
  }
  // ⓪″ 拓扑级 web 族（v0.7，T4 联网状态图标）：status.result 启动查询回执
  //    / status.changed 四时机广播 → topology.webStatus 写入；stop.result
  //    直通（状态回流经广播）——同 model/agent-config 族两层拓扑前置
  if (isWebEventType(frame.type)) {
    return applyWebEvent(topo, frame);
  }
  // ① 后台会话帧：轻量 store 消费。草稿态 activeId 可为 null——后台路由不
  //    依赖 activeId 非空（bug3 修复：旧守卫「activeId!==null」是 v0.1 兼容
  //    缺省，其「activeId 为 null 只发生在首连前」假设已被草稿态打破；v0.1
  //    兼容仅覆盖**无信封 sessionId** 的帧落活跃）。
  //    session.snapshot 例外：连接级重建指令（草稿建会话链/订阅切换/重连）——
  //    无论目标会话是否在后台，一律路由活跃完整 store（目标转活跃）
  if (
    sid !== undefined &&
    sid !== SYSTEM_SESSION_ID &&
    frame.type !== "session.snapshot" &&
    sid !== activeId
  ) {
    return applyBackgroundFrame(topo, frame);
  }
  // ② 拓扑级清单族（session.list.result 点对点结果 / session.list_changed 广播）
  if (isDirectoryEventType(frame.type)) {
    return applyDirectoryEvent(topo, frame);
  }
  // ③ 活跃完整 store 消费者注册表（未注册 type 保持原状态）
  const handler = route(frame.type);
  if (!handler) return topo;
  const active = handler(topo.active, frame, ts);
  // 快照使目标会话转活跃：background 同名轻量态清理（草稿建会话链防双源）
  if (frame.type === "session.snapshot" && active.sessionId !== null) {
    const stale = topo.background[active.sessionId];
    if (stale !== undefined) {
      const background = { ...topo.background };
      delete background[active.sessionId];
      return { ...topo, active, background };
    }
  }
  return { ...topo, active };
}

/** 后台会话帧 → 轻量 store 更新（未知会话原样返回）。 */
function applyBackgroundFrame(topo: TopologyState, frame: EventEnvelope): TopologyState {
  const sid = frame.sessionId!;
  const bg = topo.background[sid];
  if (bg === undefined) return topo; // 未知会话：多会话隔离，不误写
  return { ...topo, background: { ...topo.background, [sid]: consumeBackground(bg, frame) } };
}

/**
 * 未读候选类型（与 monitor 档白名单同规 3 类型；daemon 单源 = EventStream
 * MONITOR_TIER_EVENT_TYPES，shell 侧禁引 daemon——fake-transport 同规先例）。
 * 关键推论：monitor 档下 daemon 只推这 3 类——**白名单外帧到达后台会话 ⟹
 * 必是降级竞态窗口内的 full 档存量**（推送时刻该会话仍活跃、内容用户已见）
 * ⟹ 一律不计未读。只有白名单 3 类可能代表「后台新内容」，需存量对账区分。
 */
const UNREAD_CANDIDATE_TYPES: ReadonlySet<string> = new Set([
  "chat.turn.started",
  "chat.turn.completed",
  "chat.message.completed",
]);

/** 存量对账：帧锚（entry id / turnId）命中降级时刻已见游标 → 活跃期已读内容，不计未读。 */
function isSeenFrame(bg: BackgroundSessionState, frame: EventEnvelope): boolean {
  switch (frame.type) {
    case "chat.message.completed":
      // D-2：流式 delta 的 messageId 与最终 entry id 同源——流式中降级、后台
      // 完成的帧其 entry.id 命中 seen.entryIds（含流式 messageId）
      return bg.seen.entryIds.includes((frame.payload as ChatMessageCompletedPayload).entry.id);
    case "chat.turn.started":
    case "chat.turn.completed":
      // 窗口内晚到的 turn 帧只会是降级时进行中轮次的（WS 有序，更早轮次的帧
      // 不可能晚到）；seen.turnId=null（降级时已无进行中轮次）→ 无锚可免，保守计
      return (
        bg.seen.turnId !== null &&
        (frame.payload as ChatTurnStartedPayload).turnId === bg.seen.turnId
      );
    default:
      return false;
  }
}

/** 后台帧消费：未读 +1（白名单 3 类且存量对账未命中）+ 运行态徽标投影（不渲染 entries 只计数）。 */
function consumeBackground(bg: BackgroundSessionState, frame: EventEnvelope): BackgroundSessionState {
  // model.changed / thinking.changed（thinking 批①同判）：会话参数变更非内容
  // 事件——不计未读、轻量态无对应字段
  if (frame.type === "model.changed" || frame.type === "thinking.changed") return bg;
  const countsUnread =
    frame.channel !== "session" && UNREAD_CANDIDATE_TYPES.has(frame.type) && !isSeenFrame(bg, frame);
  return {
    ...bg,
    runState: backgroundRunStateOf(frame, bg.runState),
    unread: countsUnread ? bg.unread + 1 : bg.unread,
  };
}

/**
 * 后台运行态徽标投影（帧驱动）：流式 → streaming；编排族 → subagent_running；
 * 回 idle → idle。权威覆盖面 = session.list_changed{state_changed} 元数据同步
 * （directory 消费者），本投影作为帧间即时脉冲补充。
 */
function backgroundRunStateOf(
  frame: EventEnvelope,
  current: BackgroundSessionState["runState"],
): BackgroundSessionState["runState"] {
  switch (frame.type) {
    case "chat.stream.delta":
      return "streaming";
    case "agent.spawned":
    case "agent.queued":
    case "agent.started":
      return "subagent_running";
    case "agent.state.changed":
      return frame.payload.state === "idle" ? "idle" : "streaming";
    case "chat.turn.completed":
      return "idle";
    default:
      return current;
  }
}
