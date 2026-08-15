import { describe, expect, test } from "bun:test";
import {
  COMMAND_TYPES,
  EVENT_TYPES,
  PROTOCOL_VERSION,
  type ChatSendCommand,
  type CommandEnvelope,
  type EntryDto,
  type EventEnvelope,
  type HelloCommand,
  type MessageEntryDto,
  type SessionSnapshotDto,
  type ToolCallEntryDto,
  type WorkspaceRoute,
} from "../src/index";

/**
 * TP-CL2-1（U）：协议 v0 类型完备性（CL-2 / F(2).1 标准 1/2）。
 *
 * ① 样例帧构造：hello/welcome/snapshot/delta/工具卡/steer 徽标事件以契约类型
 *    构造并通过类型检查（tsc 守护）+ 结构断言（运行时）。
 * ② 信封 v 位 = 字面量 0；workspace 预留字段位可携带可省略（AD-7：仅类型，
 *    零路由行为）。
 * ③ 命令目录 5 个 / 事件目录 12 个 type 全覆盖，且与信封联合一一对应
 *    （COMMAND_TYPES/EVENT_TYPES 常量目录 ↔ 联合 type 提取双向一致）。
 * ④ 判别式联合窄化：switch(event.type) 各分支 payload 窄化正确；
 *    switch(entry.kind) 两分支窄化正确；steerState 仅 message 变体携带。
 *
 * 类型级断言（Equal/Expect/@ts-expect-error）由 `tsc --noEmit` 守护：
 * 窄化失效或字段缺失 → 编译失败；运行时断言验证样例帧行为。
 */

// ── 类型级断言工具（仅编译期） ────────────────────────────────
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;
/** 从信封联合提取全部 type 字面量 */
type EnvelopeTypeOf<U> = U extends { type: infer T } ? T : never;

// ── 样例帧（构造本身即类型检查：字段缺失/多余/拼写错 → tsc 失败） ──
const helloFrame: HelloCommand = {
  v: PROTOCOL_VERSION,
  type: "hello",
  payload: { token: "dev-token-xyz", protocolVersion: 0 },
};

const chatSendWithRoute: ChatSendCommand = {
  v: 0,
  type: "chat.send",
  payload: { text: "帮我看看 protocol 包的类型" },
  workspace: { workspaceId: "ws-main" }, // 预留字段位：可携带（当前无路由语义）
};
const chatSendPlain: ChatSendCommand = {
  v: 0,
  type: "chat.send",
  payload: { text: "hi" }, // workspace 可省略
};

const snapshot: SessionSnapshotDto = {
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

const sampleEvents: EventEnvelope[] = [
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
];

const sampleCommands: CommandEnvelope[] = [
  chatSendPlain,
  { v: 0, type: "chat.steer", payload: { text: "改用方案 B" } },
  { v: 0, type: "chat.abort", payload: {} },
  { v: 0, type: "session.subscribe", payload: {} },
  { v: 0, type: "session.unsubscribe", payload: {} },
];

// ── 窄化函数：每个分支访问该分支 payload 独有字段（窄化失效 → tsc 失败） ──
function summarizeEvent(event: EventEnvelope): string {
  switch (event.type) {
    case "connection.welcome":
      return `welcome:${event.payload.sessionId}:${event.payload.model}:${event.payload.agentState}`;
    case "connection.error":
      return `error:${event.payload.code}:${event.payload.message}`;
    case "session.snapshot":
      return `snapshot:${event.payload.snapshot.sessionId}:${event.payload.snapshot.entries.length}:${event.payload.snapshot.revision}`;
    case "chat.stream.delta":
      return `delta:${event.payload.messageId}:${event.payload.delta}`;
    case "chat.turn.started":
      return `turn-start:${event.payload.turnId}`;
    case "chat.turn.completed":
      return `turn-end:${event.payload.turnId}:${event.payload.reason}`;
    case "chat.message.completed":
      return `msg:${event.payload.entry.id}`;
    case "steer.queued":
      return `steer-q:${event.payload.entryId}`;
    case "steer.drained":
      return `steer-d:${event.payload.entryId}`;
    case "tool.call.started":
      return `tool-start:${event.payload.entry.id}`;
    case "tool.call.result":
      return `tool-result:${event.payload.entry.id}`;
    case "agent.state.changed":
      return `state:${event.payload.state}`;
    default: {
      const _exhaustive: never = event; // 目录外事件 → 编译失败（穷尽性守护）
      return `unhandled:${String(_exhaustive)}`;
    }
  }
}

function dispatchCommand(cmd: CommandEnvelope): string {
  switch (cmd.type) {
    case "chat.send":
      return `send:${cmd.payload.text}`;
    case "chat.steer":
      return `steer:${cmd.payload.text}`;
    case "chat.abort":
      return "abort";
    case "session.subscribe":
      return "subscribe";
    case "session.unsubscribe":
      return "unsubscribe";
    default: {
      const _exhaustive: never = cmd;
      return `unhandled:${String(_exhaustive)}`;
    }
  }
}

function describeEntry(entry: EntryDto): string {
  switch (entry.kind) {
    case "message":
      return `msg:${entry.role}:${entry.content}${entry.steerState ? `:${entry.steerState}` : ""}`;
    case "tool-call":
      return `tool:${entry.name}:${entry.state}${entry.durationMs ? `:${entry.durationMs}ms` : ""}`;
  }
}

// ── 类型级断言（编译期；任一不满足 → tsc --noEmit 失败） ──
// 信封 v 位为字面量 0（版本位内建，AD-9）
type _VIsZero = Expect<Equal<HelloCommand["v"], 0>>;
// 命令目录常量 ↔ 命令信封联合 type 集合双向一致（5 个）
type _CommandSync = Expect<Equal<EnvelopeTypeOf<CommandEnvelope>, (typeof COMMAND_TYPES)[number]>>;
// 事件目录常量 ↔ 事件信封联合 type 集合双向一致（12 个）
type _EventSync = Expect<Equal<EnvelopeTypeOf<EventEnvelope>, (typeof EVENT_TYPES)[number]>>;
// EntryDto 判别式联合两分支即 message / tool-call 变体
type _EntryMessage = Expect<Equal<Extract<EntryDto, { kind: "message" }>, MessageEntryDto>>;
type _EntryTool = Expect<Equal<Extract<EntryDto, { kind: "tool-call" }>, ToolCallEntryDto>>;

// 负向断言：tool-call 变体不携带 steerState（仅 chat.steer 用户消息变体）
// @ts-expect-error steerState 不存在于 ToolCallEntryDto
const badToolEntry: ToolCallEntryDto = { kind: "tool-call", id: "x", name: "n", args: "{}", state: "done", ts: 1, steerState: "queued" };
// 负向断言：v 位不接受非 0 版本
// @ts-expect-error v 位必须是 0
const badVersion: HelloCommand = { v: 1, type: "hello", payload: { token: "t", protocolVersion: 0 } };

// ── 运行时断言 ────────────────────────────────────────────────
describe("TP-CL2-① 样例帧构造（契约 §2–§6）", () => {
  test("hello/welcome/snapshot/delta/工具卡/steer 徽标样例帧结构正确", () => {
    expect(helloFrame.v).toBe(0);
    expect(helloFrame.type).toBe("hello");
    expect(helloFrame.payload.token).toBe("dev-token-xyz");
    expect(helloFrame.payload.protocolVersion).toBe(0);

    const byType = new Map(sampleEvents.map((e) => [e.type, e] as const));
    const welcome = byType.get("connection.welcome");
    expect(welcome?.type === "connection.welcome" && welcome.payload.model).toBe("kimi-k2");
    const snap = byType.get("session.snapshot");
    expect(
      snap?.type === "session.snapshot" && snap.payload.snapshot.entries.length,
    ).toBe(3);
    const delta = byType.get("chat.stream.delta");
    expect(delta?.type === "chat.stream.delta" && delta.payload.delta).toBe("流式半句");
    const toolStart = byType.get("tool.call.started");
    expect(
      toolStart?.type === "tool.call.started" && toolStart.payload.entry.kind,
    ).toBe("tool-call");
    // steer 徽标两事件（review.md 徽标语义的依据）
    expect(byType.get("steer.queued")?.type === "steer.queued").toBe(true);
    expect(byType.get("steer.drained")?.type === "steer.drained").toBe(true);
  });

  test("信封 workspace 预留字段位：可携带（含 WorkspaceRoute）可省略", () => {
    expect(chatSendWithRoute.workspace?.workspaceId).toBe("ws-main");
    expect(chatSendPlain.workspace).toBeUndefined();
    const route: WorkspaceRoute = { workspaceId: "ws-1" };
    expect(route.workspaceId).toBe("ws-1");
    const bareRoute: WorkspaceRoute = {}; // workspaceId 本身可选
    expect(bareRoute.workspaceId).toBeUndefined();
  });
});

describe("TP-CL2-③ 命令/事件目录完备性（契约 §4/§5）", () => {
  test("命令目录恰为 5 个 type", () => {
    expect([...COMMAND_TYPES].sort()).toEqual(
      ["chat.abort", "chat.send", "chat.steer", "session.subscribe", "session.unsubscribe"],
    );
  });

  test("事件目录恰为 12 个 type", () => {
    expect([...EVENT_TYPES].sort()).toEqual(
      [
        "agent.state.changed",
        "chat.message.completed",
        "chat.stream.delta",
        "chat.turn.completed",
        "chat.turn.started",
        "connection.error",
        "connection.welcome",
        "session.snapshot",
        "steer.drained",
        "steer.queued",
        "tool.call.result",
        "tool.call.started",
      ],
    );
  });

  test("全部 5 个命令信封可构造且可分发", () => {
    const out = sampleCommands.map(dispatchCommand);
    expect(out).toEqual([
      "send:hi",
      "steer:改用方案 B",
      "abort",
      "subscribe",
      "unsubscribe",
    ]);
  });

  test("全部 12 个事件信封可构造且窄化分发正确", () => {
    const out = sampleEvents.map(summarizeEvent);
    expect(out).toEqual([
      "welcome:sess-1:kimi-k2:running",
      "error:auth.missing_token:握手缺少 token",
      "snapshot:sess-1:3:42",
      "delta:e5:流式半句",
      "turn-start:turn-7",
      "turn-end:turn-7:aborted",
      "msg:e5",
      "steer-q:e2",
      "steer-d:e2",
      "tool-start:e6",
      "tool-result:e6",
      "state:steering",
    ]);
  });
});

describe("TP-CL2-④ EntryDto 判别式联合（契约 §6）", () => {
  test("switch(entry.kind) 两分支窄化：steerState 仅 message 变体", () => {
    expect(snapshot.entries.map(describeEntry)).toEqual([
      "msg:user:跑一下单测",
      "msg:user:先别动，改用方案 B:queued",
      "tool:run_tests:done:1200ms",
    ]);
    // 负向样例（badToolEntry）由上方 @ts-expect-error 在编译期守护：
    // tool-call 变体携带 steerState → tsc 失败
    expect(badToolEntry.state).toBe("done"); // 运行时仅访问合法字段
    expect(badVersion.payload.protocolVersion).toBe(0);
  });
});

describe("TP-CL2-② 信封 v 位与版本常量", () => {
  test("PROTOCOL_VERSION = 0，样例帧 v 位全为 0", () => {
    expect(PROTOCOL_VERSION).toBe(0);
    for (const frame of [helloFrame, ...sampleEvents, ...sampleCommands]) {
      expect(frame.v).toBe(0);
      expect(typeof frame.type).toBe("string");
    }
  });
});
