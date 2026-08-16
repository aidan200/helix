/**
 * entities/session —— 会话投影 reducer 组合面（W7/CL-7；AD-16 纯投影；
 * v0.1 扩：CL-1/2/3；C2 拆分组合点，T1.1）。
 *
 * 状态 = 连接态 × 会话投影。全部领域内容由 WS 事件流（@helix/protocol
 * EventEnvelope）投影而来：前端零权威状态，重连恢复 = daemon 快照 + 增量，
 * 无本地补齐。C2 拆分（AD-3 前端形态）后本文件 = 组合导出 + ui action 骨架 +
 * 事件经 dispatcher 注册表路由（type → 五块消费者）：
 *   state.ts / entries.ts / channel.ts / instance-cards.ts   状态面与共享投影工具
 *   consumers/   conn（连接态+connection.*）/ chat（消息流+steer+engine.error+
 *                tool+agent.state.changed）/ agent（编排族）/ thinking·usage / snapshot
 *   dispatcher/  事件注册表（纯映射；WS 帧接线归 T3.1）
 * 本文件为纯函数（无 React / 无 IO / 无 Date.now），可重放：
 *   ① 同一 action 序列重放两次 → 状态幂等一致；
 *   ② 前缀投影快照 + 后续增量 = 全量重放（session-reducer.test.ts 守护）。
 *
 * 本地仅存纯 UI 态：draft（输入草稿）、工具卡展开（组件态）、主题/i18n
 * （localStorage 白名单键，AG-14）。
 */
import type { EventEnvelope, MessageEntryDto } from "@helix/protocol";
import { applyConnAction, isConnAction } from "./consumers/conn";
import { route } from "./dispatcher";
import { LOCAL_PREFIX, type SessionAction, type SessionState } from "./state";

// ── 组合导出（原导出面不变；类型/常量/工厂落 state.ts，路径零变更）──
export { MAIN_INSTANCE_ID, createInitialSessionState } from "./state";
export type {
  ChannelItem,
  ChannelLcKey,
  ChannelStream,
  ConnState,
  InstanceCardState,
  KillToast,
  RestoreToast,
  SessionAction,
  SessionState,
  SessionUsageProjection,
  SpawnToast,
  StreamingState,
} from "./state";

// ── 派生选择子（纯函数）──────────────────────────────────────

/** 空会话态：connected 且无条目且无实例且无流式且非生成中（empty 引导页可见条件）。 */
export function selectIsEmpty(s: SessionState): boolean {
  return (
    s.conn === "connected" &&
    s.entries.length === 0 &&
    s.instances.length === 0 &&
    s.streaming === null &&
    !selectIsGenerating(s)
  );
}

/** 生成中（steer 提示行 / 输入不锁死的判据）：流式或有活跃 agent 态。 */
export function selectIsGenerating(s: SessionState): boolean {
  return (
    s.streaming !== null || s.agentState === "running" || s.agentState === "steering"
  );
}

/** 发送前置条件 = connected（SM 规则 6：非 connected 不给出可发入口）。 */
export function selectCanSend(s: SessionState): boolean {
  return s.conn === "connected";
}

// ── reducer ─────────────────────────────────────────────────

/** 事件 → dispatcher 注册表路由；未注册 type 保持原状态（原 default 分支语义）。 */
function applyEvent(s: SessionState, event: EventEnvelope, ts?: number): SessionState {
  const handler = route(event.type);
  return handler ? handler(s, event, ts) : s;
}

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  // 连接态切换从不清空投影与草稿（SM 规则 4/5；conn 消费者承接）
  if (isConnAction(action)) return applyConnAction(state, action);
  switch (action.type) {
    case "event":
      return applyEvent(state, action.event, action.ts);
    case "ui/set-draft":
      return { ...state, draft: action.text };
    case "ui/send": {
      const text = action.text.trim();
      if (!selectCanSend(state) || text === "") return state; // SM 规则 6：非 connected 拒发
      if (action.mode === "steer") {
        // steer echo：立即可见的 user 气泡 + queued 徽标；id 对账交给 steer.queued
        const echo: MessageEntryDto = {
          kind: "message",
          id: `${LOCAL_PREFIX}${state.nextLocalSeq}`,
          role: "user",
          content: text,
          ts: action.ts,
          steerState: "queued",
        };
        return {
          ...state,
          draft: "",
          entries: [...state.entries, echo],
          nextLocalSeq: state.nextLocalSeq + 1,
        };
      }
      // turn 模式不做本地 echo：气泡由 daemon 的 chat.message.completed 投影
      return { ...state, draft: "" };
    }
    case "ui/consume-restore-toast":
      return { ...state, restoreToast: null };
    case "ui/consume-spawn-toast":
      return { ...state, spawnToast: null };
    case "ui/consume-kill-toast":
      return { ...state, killToast: null };
    default:
      return state;
  }
}
