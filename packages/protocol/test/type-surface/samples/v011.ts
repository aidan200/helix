import { PROTOCOL_VERSION } from "../../../src/index";
import type {
  AgentInstantiatedEvent,
  CatalogModel,
  CommandEnvelope,
  EventEnvelope,
  ThinkingChangedEvent,
  ThinkingSetCommand,
} from "../../../src/index";

/**
 * v0.11 样例帧（thinking 批 additive 四块，iter-20260823-6ps5 T1.1；
 * 契约 = development/contracts/thinking-protocol.md，PROTOCOL.md §17.11）：
 * ① thinking.set 命令 + thinking.changed 广播（会话状态命令族，仿 model.set/
 *    model.changed 形态）；② CatalogModel 防腐 reasoning 能力位；
 * ④ agent.instantiated payload + thinkingLevel。
 * 字符串透传纪律（AD-2）：level/override/effective/thinkingLevels/thinkingLevel
 * 全部 `string`——helix 任何一层不维护第二份档位枚举（SoT 在 pi-ai）。
 */

// ── 命令样例 ──

/** thinking.set：会话 thinking 档覆盖（信封 sessionId 必填，per-session；下一 turn 生效）。 */
export const thinkingSet: ThinkingSetCommand = {
  v: PROTOCOL_VERSION,
  type: "thinking.set",
  sessionId: "sess-1",
  payload: { level: "xhigh" },
};

// ── 事件样例 ──

/** thinking.changed：覆盖生效广播（override = 用户拖到的档；effective = 引擎按模型能力解析的生效档）。 */
export const thinkingChanged: ThinkingChangedEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "thinking",
  type: "thinking.changed",
  payload: { override: "xhigh", effective: "high" }, // 模型能力所限：override ≠ effective（F1.3 轻提示数据源）
};

/** thinking.changed：全链不支持（effective = null——不传参，provider 默认；不报错）。 */
export const thinkingChangedUnsupported: ThinkingChangedEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "thinking",
  type: "thinking.changed",
  payload: { override: "high", effective: null },
};

// ── DTO 样例 ──

/** CatalogModel：reasoning=true + thinkingLevels 升序档序列（pi-ai thinkingLevelMap 非 null 键集派生）。 */
export const catalogModelReasoning: CatalogModel = {
  id: "anthropic/claude-sonnet-4-5",
  providerId: "anthropic",
  contextWindow: 200000,
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  source: "builtin",
  reasoning: true,
  thinkingLevels: ["low", "medium", "high", "xhigh"],
};

/** CatalogModel：reasoning=false → thinkingLevels 空数组（UI 禁用推理控件）。 */
export const catalogModelNoReasoning: CatalogModel = {
  id: "zai/glm-5.3",
  providerId: "zai",
  contextWindow: 131072,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
  source: "overlay",
  reasoning: false,
  thinkingLevels: [],
};

/** agent.instantiated：payload additive + thinkingLevel（SubAgent spawn 解析快照；只落盘不广播语义不变，AF-6）。 */
export const agentInstantiatedThinking: AgentInstantiatedEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "agent",
  type: "agent.instantiated",
  instanceId: "agent-1",
  payload: {
    instanceId: "agent-1",
    profileKind: "subagent-worker",
    thinkingLevel: "medium", // 解析快照（自身 profile 槽位 > 兜底 medium，AD-6）
    profileSnapshot: {
      systemPrompt: "你是 helix 的 SubAgent worker。",
      tools: ["bash", "read", "write", "edit", "grep"],
      model: "zai/glm-5.3",
    },
  },
};

export const v011Commands: CommandEnvelope[] = [thinkingSet];
export const v011Events: EventEnvelope[] = [
  thinkingChanged,
  thinkingChangedUnsupported,
  agentInstantiatedThinking,
];
