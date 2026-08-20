import { PROTOCOL_VERSION } from "../../../src/index";
import type {
  AgentInstanceDto,
  ChatSteerCommand,
  CommandEnvelope,
  EventEnvelope,
  SessionSubscribeCommand,
  SessionUnsubscribeCommand,
} from "../../../src/index";

/**
 * v0.3 样例帧（spawn 锚点三形态/tier 订阅两形态/steer 定向两形态）
 * （T3.4 自 test/type-surface.test.ts 按版本批次归档迁出，批次身份保留；const 导出，语义随导出保留。）
 */
// ── v0.3 样例帧（契约 = PROTOCOL.md §12.1/§12.2/§12.3；构造即类型检查） ──

/** CL-1 spawn 锚点：agent.spawned 增量帧三形态（string 锚 / null 流首 / 缺省主实例） */
export const spawnedAnchored: EventEnvelope = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "agent",
  type: "agent.spawned",
  payload: { agentId: "agent-1", task: "契约 v0.3 定形", profileKind: "subagent-worker", anchorEntryId: "e12" },
};
export const spawnedStreamHead: EventEnvelope = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "agent",
  type: "agent.spawned",
  payload: { agentId: "agent-0", task: "流首锚点", profileKind: "subagent-worker", anchorEntryId: null }, // null = 流首（有效值）
};
/** CL-1 快照面：instances[].anchorEntryId（与 agent.spawned 增量帧同源供给） */
export const instanceAnchored: AgentInstanceDto = {
  instanceId: "agent-1",
  kind: "subagent",
  profileKind: "subagent-worker",
  state: "running",
  createdAt: "2026-08-18T12:00:00.000Z",
  anchorEntryId: "e12",
};
export const instanceMainNoAnchor: AgentInstanceDto = {
  instanceId: "main",
  kind: "main",
  profileKind: "main-session",
  state: "running",
  createdAt: "2026-08-18T11:00:00.000Z", // 主实例：缺省不携带（undefined）
};

/** CL-2 monitor 档订阅：payload 从 EmptyPayload 换 SessionSubscribePayload（tier 可选；缺省 full） */
export const subscribeMonitor: SessionSubscribeCommand = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  type: "session.subscribe",
  payload: { tier: "monitor" },
};
export const subscribeTierDefault: SessionSubscribeCommand = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  type: "session.subscribe",
  payload: {}, // 缺省 full（既有语义不变；空 payload 仍合法）
};
/** session.unsubscribe 不动：payload 保持 EmptyPayload */
export const unsubscribeUnchanged: SessionUnsubscribeCommand = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  type: "session.unsubscribe",
  payload: {},
};

/** CL-3 steer 定向寻址：可选 instanceId（缺省 = 主实例） */
export const steerTargeted: ChatSteerCommand = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  type: "chat.steer",
  payload: { text: "定向注入 agent-1", instanceId: "agent-1" },
};
export const steerMainDefault: ChatSteerCommand = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  type: "chat.steer",
  payload: { text: "主实例缺省路径" },
};

export const v03Commands: CommandEnvelope[] = [subscribeMonitor, subscribeTierDefault, steerTargeted];
export const v03Events: EventEnvelope[] = [spawnedAnchored, spawnedStreamHead];
