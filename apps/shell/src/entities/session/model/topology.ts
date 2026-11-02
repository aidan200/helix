/**
 * store 拓扑 reducer（AD-3 §3.4：活跃完整 store + 后台轻量 store；T3.1）。
 *
 * TopologyState = 活跃 SessionState（全量）× 后台轻量 store × 会话清单。
 * action 承接：
 * - "event"：帧经 dispatcher 帧入口（dispatchFrame）按信封 sessionId 路由；
 * - "session/switch-started"：切换两阶段（P-1s）——旧活跃转后台轻量
 *   （不存 entries），目标 = 全新 loading store（连接态字段保留，同一 WS
 *   连接切换不断线）；快照到达（snapshot 消费者）转 ready + 输入恢复；
 * - "ui/load-earlier"：向上分页门控（hasMore && !loading 才置 loading；
 *   命令发送归 provider——selectCanLoadEarlier 为发送判据）；
 * - 其余 action（conn/* 与 ui/*）透传活跃完整 store（sessionReducer）。
 * 瀑布序约束：旧活跃转轻量时 nextChannelSeq 不带入（重建 store 的 seq 从
 * 快照重算——per-store 单调，channelsFromSnapshot 语义保持）。
 * 纯函数纪律（AG-14）：无 React / 无 IO / 无 Date.now。
 */
import type { SessionMeta } from "@helix/protocol";
import { isTerminal } from "./instance-cards";
import { sessionReducer } from "./session-reducer";
import {
  createInitialSessionState,
  createInitialTopologyState,
  type BackgroundSessionState,
  type SessionAction,
  type SessionState,
  type TopologyState,
} from "./state";
import { dispatchFrame } from "./dispatcher/frame";
import { applyModelConfigAction, clearModelConfigInflight } from "./consumers/model-config";

export { createInitialTopologyState };
export type {
  BackgroundSessionState,
  HistoryPaging,
  SessionViewPhase,
  TopologyState,
} from "./state";

/** 活跃会话运行态投影（侧栏活跃卡片徽标与 demoteToBackground 同源）：
 *  有非终态 SubAgent（含 parked——与 daemon `hasActiveInstances` 同序：
 *  parked 窗口进程驻留未销毁，故仍算活跃）→ subagent_running；agentState
 *  流式/转向 → streaming；否则 idle。纯函数（AG-14）。
 *  TR-213 同序纪律：本函数与 daemon `SessionRegistry.runStateOf` 必须同判据
 *  （daemon 侧已显式含 parked），改任一侧都要同步另一侧。 */
export function selectActiveRunState(active: SessionState): BackgroundSessionState["runState"] {
  const subagentActive = active.instances.some((c) => !isTerminal(c.state));
  if (subagentActive) return "subagent_running";
  return active.agentState === "idle" ? "idle" : "streaming";
}

/** 旧活跃 store → 后台轻量态（标题/运行态取清单元数据；未读从零起算）。
 *  seen 游标收集降级时刻活跃期已见锚（entries 全量装载窗口 id + 流式
 *  messageId + 实例流式 messageId + 进行中轮次 turnId）——降级竞态窗口内
 *  晚到的存量帧经其对账不计未读（frame.ts consumeBackground）；entryIds
 *  用 Set 承载（M35：对账 O(1)）。 */
function demoteToBackground(active: SessionState, list: SessionMeta[]): BackgroundSessionState | null {
  if (active.sessionId === null) return null; // 无会话上下文（草稿/首连前）：无轻量态可转
  const meta = list.find((m) => m.sessionId === active.sessionId);
  return {
    sessionId: active.sessionId,
    title: meta?.title ?? "",
    runState: selectActiveRunState(active),
    lastActivityAt: meta?.lastActivityAt ?? 0,
    unread: 0,
    seen: {
      entryIds: new Set<string>([
        ...active.entries.map((e) => e.id),
        ...(active.streaming !== null ? [active.streaming.messageId] : []),
        ...Object.values(active.channelStreams).map((cs) => cs.messageId),
        // steerQueue 预分配 entryId：drain 落盘的 message.completed 锚
        //（排队注入 = 用户已知内容，后台落盘不计未读）
        ...active.steerQueue.map((item) => item.id),
      ]),
      turnId: active.currentTurnId,
    },
  };
}

/** 目标会话全新 loading store（P-1s 骨架态）：投影全清零，连接态字段保留。
 *  per-session 草稿回填（输入框保留批）：回填值由调用方取出后传入（取出即删
 *  的 map 更新归 switchActiveSession）——本函数不触碰 map，保持纯函数（AG-14）；
 *  在场会话单一数据源在活跃 store.draft，回填后活跃期增删与 map 无关（切走时重写）。 */
function freshLoadingActive(prev: SessionState, target: string, draft: string | undefined): SessionState {
  return {
    ...createInitialSessionState(),
    ...(draft !== undefined && draft !== "" ? { draft } : {}),
    conn: prev.conn,
    connAttempts: prev.connAttempts,
    connError: prev.connError,
    hasConnected: prev.hasConnected,
    daemonFreshness: prev.daemonFreshness, // 连接级事实（同一 WS 不重握手，stale-indicator 批）
    sessionId: target,
  };
}

/** 草稿态活跃 store（F(1.2).1）：无会话上下文、无快照在途 → view=ready
 *  （空态直接可见、输入可用）；连接态字段保留（同一 WS）。 */
function freshDraftActive(prev: SessionState): SessionState {
  return {
    ...createInitialSessionState(),
    conn: prev.conn,
    connAttempts: prev.connAttempts,
    connError: prev.connError,
    hasConnected: prev.hasConnected,
    daemonFreshness: prev.daemonFreshness, // 连接级事实（同一 WS 不重握手，stale-indicator 批）
    view: "ready",
  };
}

/** 切走时把活跃草稿落入 per-session 暂存（不可变更新：无变化原引用）：
 *  非空 → 写入（切回回填）；空串 → 清条目（用户已明确清空，不复活）；
 *  草稿态（sessionId=null）无处回填不入 map。 */
function stashActiveDraft(drafts: Map<string, string>, active: SessionState): Map<string, string> {
  if (active.sessionId === null) return drafts;
  if (active.draft === "" && !drafts.has(active.sessionId)) return drafts;
  const next = new Map(drafts);
  if (active.draft === "") next.delete(active.sessionId);
  else next.set(active.sessionId, active.draft);
  return next;
}

/** 切换会话（provider 已发 unsubscribe 旧 + subscribe 新后 dispatch）。
 *  纯度（AG-14 + StrictMode 双调用安全）：回填条目的取出即删在**新 map 副本**
 *  上执行——禁原地 delete 输入状态的 map（dev StrictMode 双调用同一输入时，
 *  第一次调用的变异会让第二次读到空 map，回填丢草稿）。 */
function switchActiveSession(topo: TopologyState, target: string): TopologyState {
  if (topo.active.sessionId === target) return topo; // 同会话重复切换：原样
  const background = { ...topo.background };
  const demoted = demoteToBackground(topo.active, topo.list);
  if (demoted !== null) background[demoted.sessionId] = demoted;
  delete background[target]; // 目标会话轻量态移除（转活跃；未读随之消解）
  const stashed = stashActiveDraft(topo.sessionDrafts, topo.active);
  // 回填取出即删：新副本上执行（stashed === topo.sessionDrafts 时更不可原地动）
  const draft = stashed.get(target);
  const sessionDrafts = draft !== undefined ? new Map([...stashed].filter(([k]) => k !== target)) : stashed;
  return { ...topo, background, sessionDrafts, active: freshLoadingActive(topo.active, target, draft) };
}

/** 新建草稿（provider 已发 unsubscribe 旧会话后 dispatch）：活跃转轻量照常
 *  执行（后台照跑，F(1.0).5），活跃 store 置草稿态。重复新建（已草稿）原样。 */
function startNewDraft(topo: TopologyState): TopologyState {
  if (topo.active.sessionId === null) return topo;
  const background = { ...topo.background };
  const demoted = demoteToBackground(topo.active, topo.list);
  if (demoted !== null) background[demoted.sessionId] = demoted;
  return { ...topo, background, sessionDrafts: stashActiveDraft(topo.sessionDrafts, topo.active), active: freshDraftActive(topo.active) };
}

/** 加载更早（H-2：胶囊点击触发；门控：hasMore && !loading；命令发送判据归 provider）。 */
function beginLoadEarlier(s: SessionState): SessionState {
  if (!s.history.hasMore || s.history.loading) return s;
  return { ...s, history: { ...s.history, loading: true } };
}

/** 可发加载更早命令（provider 发送判据）：就绪 + 有下一页 + 游标有效。 */
export function selectCanLoadEarlier(s: SessionState): boolean {
  return s.view === "ready" && s.history.hasMore && !s.history.loading && s.history.nextCursor !== null;
}

export function topologyReducer(topo: TopologyState, action: SessionAction): TopologyState {
  // 模型/厂商配置 action（T3.3）：仅触碰 modelConfig 面（活跃 store 引用不变）
  if (action.type.startsWith("model/")) {
    const modelConfig = applyModelConfigAction(topo.modelConfig, action);
    return modelConfig === topo.modelConfig ? topo : { ...topo, modelConfig };
  }
  switch (action.type) {
    case "event":
      return dispatchFrame(topo, action.event, action.ts);
    case "session/switch-started":
      return switchActiveSession(topo, action.sessionId);
    case "session/new-draft":
      return startNewDraft(topo);
    case "ui/load-earlier": {
      const active = beginLoadEarlier(topo.active);
      return active === topo.active ? topo : { ...topo, active };
    }
    case "conn/disconnected": {
      // F5 批：断连夭折全部 modelConfig 写面 in-flight（结果帧随断连永不到达，
      // 永锁防护——catalogRefreshing/verify/setKey/deleteKey/setDefault 统一清位）
      const modelConfig = clearModelConfigInflight(topo.modelConfig);
      const active = sessionReducer(topo.active, action);
      if (active === topo.active && modelConfig === topo.modelConfig) return topo;
      return { ...topo, active, modelConfig };
    }
    default: {
      // conn/* 与 ui/* 透传活跃完整 store；无变化时保持拓扑引用（浅比较友好）
      const active = sessionReducer(topo.active, action);
      return active === topo.active ? topo : { ...topo, active };
    }
  }
}
