/**
 * dispatcher 帧入口 —— v0.2 统一信封路由（AD-3 §3.4 前端形态 / AD-4 会话
 * 路由位；契约 A §1.2；T3.1 接线）。
 *
 * dispatchFrame（纯函数）：帧 → 解析信封（sessionId/channel/type）→ 按
 * sessionId 路由 → 按 type 交消费者：
 *
 * ① 后台会话帧（信封 sessionId 命中后台轻量 store）→ 轻量消费（运行态徽标
 *    投影 + 未读计数；不渲染 entries）——活跃完整 store 引用保持不变；
 *    session.snapshot 除外（见②）：快照是连接级重建指令，目标会话转活跃；
 * ② 系统帧（sessionId = SYSTEM_SESSION_ID / 缺省——v0/v0.1 兼容单会话语义 /
 *    活跃会话未建立前的帧 / session.snapshot）→ 清单族（directory 拓扑级
 *    消费者）→ 活跃完整 store 消费者注册表（五族 + model/history）；
 * ③ 未知会话帧（既非活跃也非后台）→ 原样丢弃（多会话隔离，不误写活跃 store）。
 *
 * session.snapshot 应用后清理 background 同名轻量态（草稿建会话链：
 * list_changed{created} 先播种轻量 store，快照到达转活跃——残留即双源）。
 * channel 为类型学登记（族分组），路由权威 = 信封 sessionId（契约 A §1.2）。
 * 纯函数纪律（AG-14）：无 React / 无 IO / 无 Date.now。
 */
import { SYSTEM_SESSION_ID } from "@helix/protocol";
import type { EventEnvelope } from "@helix/protocol";
import type { BackgroundSessionState, TopologyState } from "../state";
import { applyDirectoryEvent, isDirectoryEventType } from "../consumers/directory";
import {
  applyModelConfigEvent,
  isModelConfigEventType,
} from "../consumers/model-config";
import { route } from "./index";

/** v0.2 统一信封帧入口：拓扑状态 + 事件帧 → 新拓扑状态。 */
export function dispatchFrame(topo: TopologyState, frame: EventEnvelope, ts?: number): TopologyState {
  const sid = frame.sessionId;
  const activeId = topo.active.sessionId;
  // ① 后台会话帧：轻量 store 消费（activeId 未建立时缺省按活跃/系统处理——v0.1 兼容）。
  //    session.snapshot 例外：连接级重建指令（草稿建会话链/订阅切换/重连）——
  //    无论目标会话是否在后台，一律路由活跃完整 store（目标转活跃）
  if (
    sid !== undefined &&
    sid !== SYSTEM_SESSION_ID &&
    frame.type !== "session.snapshot" &&
    activeId !== null &&
    sid !== activeId
  ) {
    return applyBackgroundFrame(topo, frame);
  }
  // ② 拓扑级清单族（session.list.result 点对点结果 / session.list_changed 广播）
  if (isDirectoryEventType(frame.type)) {
    return applyDirectoryEvent(topo, frame);
  }
  // ②′ 拓扑级模型/厂商配置族（model/auth 9 类 *.result；T3.3 前置——含
  //    model.get.result（信封 sessionId=目标会话，活跃会话查询无路由问题）
  //    与 8 类全局结果帧；在活跃 store 注册表之前，全局数据不入会话 store）
  if (isModelConfigEventType(frame.type)) {
    return applyModelConfigEvent(topo, frame);
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

/** 后台帧消费：未读 +1（内容事件）+ 运行态徽标投影（不渲染 entries 只计数）。 */
function consumeBackground(bg: BackgroundSessionState, frame: EventEnvelope): BackgroundSessionState {
  if (frame.type === "model.changed") return bg; // 换模非内容事件：不计未读、轻量态无 model 字段
  const isSessionChannel = frame.channel === "session";
  return {
    ...bg,
    runState: backgroundRunStateOf(frame, bg.runState),
    unread: isSessionChannel ? bg.unread : bg.unread + 1,
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
