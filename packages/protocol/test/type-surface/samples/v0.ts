import { PROTOCOL_VERSION } from "../../../src/index";
import type {
  ChatSendCommand,
  CommandEnvelope,
  EventEnvelope,
  HelloCommand,
  SessionSnapshotDto,
} from "../../../src/index";

/**
 * v0 基线样例帧（hello/chat.send 三形态/snapshot/兼容样本 legacy×2；构造即类型检查）
 * （T3.4 自 test/type-surface.test.ts 按版本批次归档迁出，批次身份保留；const 导出，语义随导出保留。）
 */
// ── 样例帧（构造本身即类型检查：字段缺失/多余/拼写错 → tsc 失败） ──
export const helloFrame: HelloCommand = {
  v: PROTOCOL_VERSION,
  type: "hello",
  payload: { token: "dev-token-xyz", protocolVersion: PROTOCOL_VERSION },
};

export const chatSendWithRoute: ChatSendCommand = {
  v: "0.5",
  type: "chat.send",
  payload: { text: "帮我看看 protocol 包的类型" },
  workspace: { workspaceId: "ws-main" }, // 预留字段位：可携带（当前无路由语义）
};
export const chatSendPlain: ChatSendCommand = {
  v: 0, // v0 历史形态样本（FrameVersion 兼容读；workspace 同样可省略）
  type: "chat.send",
  payload: { text: "hi" },
};
/** v0.2 会话路由位：会话作用域命令携带信封 sessionId（AD-4） */
export const chatSendRouted: ChatSendCommand = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  type: "chat.send",
  payload: { text: "发给 sess-1" },
};

export const snapshot: SessionSnapshotDto = {
  sessionId: "sess-1",
  model: "kimi-k2",
  agentState: "idle",
  revision: 42,
  entries: [
    { kind: "message", id: "e1", role: "user", content: "跑一下单测", ts: 1760000000000 },
    {
      kind: "message",
      id: "e2",
      role: "user",
      content: "先别动，改用方案 B",
      ts: 1760000001000,
      steerState: "queued", // 仅 chat.steer 产生的用户消息携带
    },
    {
      kind: "tool-call",
      id: "e3",
      name: "run_tests",
      args: '{"scope":"unit"}',
      result: "3 passed",
      state: "done",
      durationMs: 1200,
      ts: 1760000002000,
    },
  ],
};

// ── 兼容样本（v0/v0.1 形态：v: 0 字面量 + 不带 sessionId/channel）──
// 信封兼容红线（契约 A §5）：历史形态帧在新类型下零修改合法。
export const legacyEvents: EventEnvelope[] = [
  { v: 0, type: "connection.welcome", payload: { sessionId: "sess-1", model: "kimi-k2", agentState: "running" } },
  { v: 0, type: "connection.error", payload: { code: "auth.missing_token", message: "握手缺少 token" } },
  { v: 0, type: "session.snapshot", payload: { snapshot } },
  { v: 0, type: "chat.stream.delta", payload: { messageId: "e5", delta: "流式半句" } },
  { v: 0, type: "chat.turn.started", payload: { turnId: "turn-7" } },
  { v: 0, type: "chat.turn.completed", payload: { turnId: "turn-7", reason: "aborted" } },
  {
    v: 0,
    type: "chat.message.completed",
    payload: { entry: { kind: "message", id: "e5", role: "assistant", content: "完整回答", ts: 1760000003000 } },
  },
  { v: 0, type: "steer.queued", payload: { entryId: "e2" } },
  { v: 0, type: "steer.drained", payload: { entryId: "e2" } },
  {
    v: 0,
    type: "tool.call.started",
    payload: { entry: { kind: "tool-call", id: "e6", name: "read_file", args: '{"path":"a.ts"}', state: "running", ts: 1760000004000 } },
  },
  {
    v: 0,
    type: "tool.call.result",
    payload: { entry: { kind: "tool-call", id: "e6", name: "read_file", args: '{"path":"a.ts"}', state: "error", result: "ENOENT", durationMs: 5, ts: 1760000004001 } },
  },
  { v: 0, type: "agent.state.changed", payload: { state: "steering" } },
  { v: 0, type: "engine.error", payload: { message: "429: 已达到 5 小时的使用上限" } },
];

export const legacyCommands: CommandEnvelope[] = [
  chatSendPlain,
  { v: 0, type: "chat.steer", payload: { text: "改用方案 B" } },
  { v: 0, type: "chat.abort", payload: {} },
  { v: 0, type: "session.subscribe", payload: {} }, // v0.2 升级后 payload 仍空（路由位在信封）
  { v: 0, type: "session.unsubscribe", payload: {} },
];
