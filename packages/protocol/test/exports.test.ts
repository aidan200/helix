import { describe, expect, test } from "bun:test";
import * as protocol from "../src/index";

/**
 * TP-CL2-2 基线（A 简版）：包内导出唯一性 + 类型面完备。
 *
 * ① 运行时值导出恰为三个目录常量（PROTOCOL_VERSION / COMMAND_TYPES /
 *    EVENT_TYPES），无意外值导出；
 * ② 类型面完备（契约 §3–§7 全部类型名经 index 可达）：下方 namespace 类型
 *    引用任一名字缺失/拼写错误 → tsc --noEmit 失败（编译期守护）；
 * ③ 子模块 star 重导出无重名冲突：TS2308 在编译期报重复导出名——
 *    `tsc --noEmit` 通过即唯一性成立（简版口径，AG-13 完整扫描自 M2 起）。
 */

// ② 类型面全集引用（编译期可达性断言；命名以 T1.2 定稿为准并已回填契约 §9）
type _TypeSurface = [
  // 信封（契约 §3）
  protocol.Envelope,
  protocol.WorkspaceRoute,
  // 握手（契约 §2）
  protocol.HelloPayload,
  protocol.HelloCommand,
  protocol.HandshakeResponse,
  // 命令目录（契约 §4）
  protocol.ChatSendPayload,
  protocol.ChatSteerPayload,
  protocol.EmptyPayload,
  protocol.ChatSendCommand,
  protocol.ChatSteerCommand,
  protocol.ChatAbortCommand,
  protocol.SessionSubscribeCommand,
  protocol.SessionUnsubscribeCommand,
  protocol.CommandEnvelope,
  protocol.CommandType,
  // 命令目录 v0.1 新增（契约 protocol-v0.1.md §4）
  protocol.AgentKillPayload,
  protocol.AgentSubscribePayload,
  protocol.AgentUnsubscribePayload,
  protocol.AgentKillCommand,
  protocol.AgentSubscribeCommand,
  protocol.AgentUnsubscribeCommand,
  // 事件目录（契约 §5）
  protocol.ConnectionWelcomePayload,
  protocol.ConnectionErrorPayload,
  protocol.SessionSnapshotPayload,
  protocol.ChatStreamDeltaPayload,
  protocol.ChatTurnStartedPayload,
  protocol.ChatTurnCompletedPayload,
  protocol.ChatMessageCompletedPayload,
  protocol.SteerQueuedPayload,
  protocol.SteerDrainedPayload,
  protocol.ToolCallStartedPayload,
  protocol.ToolCallResultPayload,
  protocol.AgentStateChangedPayload,
  protocol.ConnectionWelcomeEvent,
  protocol.ConnectionErrorEvent,
  protocol.SessionSnapshotEvent,
  protocol.ChatStreamDeltaEvent,
  protocol.ChatTurnStartedEvent,
  protocol.ChatTurnCompletedEvent,
  protocol.ChatMessageCompletedEvent,
  protocol.SteerQueuedEvent,
  protocol.SteerDrainedEvent,
  protocol.ToolCallStartedEvent,
  protocol.ToolCallResultEvent,
  protocol.AgentStateChangedEvent,
  protocol.EventEnvelope,
  protocol.EventType,
  // 事件目录 v0.1 新增（契约 protocol-v0.1.md §5）——编排族 7
  protocol.AgentSpawnedPayload,
  protocol.AgentQueuedPayload,
  protocol.AgentStartedPayload,
  protocol.AgentStalledPayload,
  protocol.AgentCompletedPayload,
  protocol.AgentFailedPayload,
  protocol.AgentKilledPayload,
  // 事件目录 v0.1 新增——通道族 4
  protocol.ThinkingStreamDeltaPayload,
  protocol.ThinkingCompletedPayload,
  protocol.CompactionCompletedPayload,
  protocol.UsageRecordedPayload,
  // 事件信封 v0.1 新增（11 个）
  protocol.AgentSpawnedEvent,
  protocol.AgentQueuedEvent,
  protocol.AgentStartedEvent,
  protocol.AgentStalledEvent,
  protocol.AgentCompletedEvent,
  protocol.AgentFailedEvent,
  protocol.AgentKilledEvent,
  protocol.ThinkingStreamDeltaEvent,
  protocol.ThinkingCompletedEvent,
  protocol.CompactionCompletedEvent,
  protocol.UsageRecordedEvent,
  // DTO（契约 §6）
  protocol.AgentStateDto,
  protocol.ChatRole,
  protocol.SteerState,
  protocol.TurnCompletionReason,
  protocol.MessageEntryDto,
  protocol.ToolCallState,
  protocol.ToolCallEntryDto,
  protocol.EntryDto,
  protocol.SessionSnapshotDto,
  // DTO v0.1 新增（契约 protocol-v0.1.md §6）
  protocol.ThinkingEntryDto,
  protocol.CompactionEntryDto,
  protocol.ClosureDto,
  protocol.InstanceState,
  protocol.AgentInstanceDto,
  protocol.UsageDto,
  protocol.SessionUsageDto,
  // 错误模型（契约 §7）
  protocol.ErrorCode,
];

describe("TP-CL2-② 导出面（index.ts 汇总）", () => {
  test("① 运行时值导出恰为三个目录常量（纯类型包纪律）", () => {
    expect(Object.keys(protocol).sort()).toEqual([
      "COMMAND_TYPES",
      "EVENT_TYPES",
      "PROTOCOL_VERSION",
    ]);
  });

  test("② 类型面全集经 index 可达（tsc 编译期守护，见 _TypeSurface）", () => {
    // 类型引用发生在模块顶层（_TypeSurface）；此处仅锚定运行时常量存在
    expect(protocol.PROTOCOL_VERSION).toBe(0);
    expect(protocol.COMMAND_TYPES.length).toBe(8); // v0.1：5 → 8
    expect(protocol.EVENT_TYPES.length).toBe(23); // v0.1：12 → 23
  });
});
