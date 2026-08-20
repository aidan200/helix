import { describe, expect, test } from "bun:test";
import * as protocol from "../src/index";

/**
 * TP-CL2-2 基线（A 简版）：包内导出唯一性 + 类型面完备。
 *
 * ① 运行时值导出恰为目录/登记/常量导出（v0.2：PROTOCOL_VERSION /
 *    COMMAND_TYPES / EVENT_TYPES / EVENT_CHANNELS / MAIN_INSTANCE_ID /
 *    SYSTEM_SESSION_ID），无意外值导出；
 * ② 类型面完备（契约 §3–§7 + v0.1/v0.2 全集经 index 可达）：下方 namespace
 *    类型引用任一名字缺失/拼写错误 → tsc --noEmit 失败（编译期守护）；
 * ③ 子模块 star 重导出无重名冲突：TS2308 在编译期报重复导出名——
 *    `tsc --noEmit` 通过即唯一性成立（简版口径，AG-13 完整扫描自 M2 起）。
 */

// ② 类型面全集引用（编译期可达性断言；v0.2 契约 A/B/C 定稿命名）
type _TypeSurface = [
  // 信封（契约 A §1；v0.2 分型）
  protocol.CommandFrame,
  protocol.EventFrame,
  protocol.FrameVersion,
  protocol.Channel,
  protocol.WorkspaceRoute,
  // 握手（契约 §2）
  protocol.HelloPayload,
  protocol.HelloCommand,
  protocol.HandshakeResponse,
  // 命令目录（契约 §4 + B §1 + C §1）
  protocol.ChatSendPayload,
  protocol.ChatSteerPayload,
  protocol.EmptyPayload,
  protocol.ChatSendCommand,
  protocol.ChatSteerCommand,
  protocol.ChatAbortCommand,
  protocol.SessionSubscribeCommand,
  protocol.SessionSubscribePayload,
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
  // 命令目录 v0.2 新增——session 族（契约 B §1）
  protocol.SessionListCommand,
  protocol.SessionListResult,
  protocol.SessionLoadHistoryPayload,
  protocol.SessionLoadHistoryCommand,
  protocol.SessionLoadHistoryResult,
  protocol.SessionDeleteCommand,
  // 命令目录 v0.2 新增——model 族（契约 C §1）
  protocol.ModelSetPayload,
  protocol.ModelSetCommand,
  protocol.ModelGetCommand,
  protocol.ModelGetResult,
  protocol.ModelCatalogCommand,
  protocol.ModelCatalogResult,
  protocol.ModelCatalogRefreshCommand,
  protocol.ModelSetDefaultPayload,
  protocol.ModelSetDefaultCommand,
  protocol.ModelSetDefaultResult,
  protocol.ModelGetDefaultCommand,
  protocol.ModelGetDefaultResult,
  // 命令目录 v0.2 新增——auth 族（契约 C §1.3，G-6 定名）
  protocol.AuthListCommand,
  protocol.AuthListResult,
  protocol.AuthSetKeyPayload,
  protocol.AuthSetKeyCommand,
  protocol.AuthSetKeyResult,
  protocol.AuthDeleteKeyPayload,
  protocol.AuthDeleteKeyCommand,
  protocol.AuthVerifyPayload,
  protocol.AuthVerifyCommand,
  protocol.AuthVerifyResult,
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
  // 事件目录 v0.1 新增（契约 protocol-v0.1.md §5）——编排族 7 + 通道族 4
  protocol.AgentSpawnedPayload,
  protocol.AgentQueuedPayload,
  protocol.AgentStartedPayload,
  protocol.AgentStalledPayload,
  protocol.AgentCompletedPayload,
  protocol.AgentFailedPayload,
  protocol.AgentKilledPayload,
  protocol.ThinkingStreamDeltaPayload,
  protocol.ThinkingCompletedPayload,
  protocol.CompactionCompletedPayload,
  protocol.UsageRecordedPayload,
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
  protocol.EngineErrorPayload,
  protocol.EngineErrorEvent,
  // 事件目录 v0.2 新增（契约 B §2 / C §2）
  protocol.SessionListChangedPayload,
  protocol.SessionListChangedEvent,
  protocol.ModelChangedPayload,
  protocol.ModelChangedEvent,
  // 事件目录微批新增（契约 C §2.2，T2.3-result-frames）
  protocol.SessionListResultPayload,
  protocol.SessionListResultEvent,
  protocol.SessionLoadHistoryResultEventPayload,
  protocol.SessionLoadHistoryResultEvent,
  protocol.ModelGetResultPayload,
  protocol.ModelGetResultEvent,
  protocol.ModelCatalogResultPayload,
  protocol.ModelCatalogResultEvent,
  protocol.ModelCatalogRefreshResultPayload,
  protocol.ModelCatalogRefreshResultEvent,
  protocol.ModelSetDefaultResultPayload,
  protocol.ModelSetDefaultResultEvent,
  protocol.ModelGetDefaultResultPayload,
  protocol.ModelGetDefaultResultEvent,
  protocol.AuthListResultPayload,
  protocol.AuthListResultEvent,
  protocol.AuthSetKeyResultPayload,
  protocol.AuthSetKeyResultEvent,
  protocol.AuthDeleteKeyResultPayload,
  protocol.AuthDeleteKeyResultEvent,
  protocol.AuthVerifyResultPayload,
  protocol.AuthVerifyResultEvent,
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
  // DTO v0.2 新增（契约 B §1.1/§2.2 + C §1.2）
  protocol.SessionMeta,
  protocol.InstanceChannelHistory,
  protocol.CatalogModel,
  protocol.CatalogModelCostRates,
  protocol.AuthProviderInfo,
  // 错误模型（契约 §7；v0.2 +command.unimplemented）
  protocol.ErrorCode,
];

describe("TP-CL2-② 导出面（index.ts 汇总）", () => {
  test("① 运行时值导出恰为目录/登记/常量六项（纯类型包纪律 + v0.2 常量收口）", () => {
    expect(Object.keys(protocol).sort()).toEqual([
      "COMMAND_TYPES",
      "EVENT_CHANNELS",
      "EVENT_TYPES",
      "MAIN_INSTANCE_ID",
      "PROTOCOL_VERSION",
      "SYSTEM_SESSION_ID",
    ]);
  });

  test("② 常量语义值 + 目录计数（v0.4：命令 22 / 事件 40；PROTOCOL_VERSION T3.2 升位收口）", () => {
    expect(protocol.PROTOCOL_VERSION).toBe("0.5"); // v0.5 批次版本位（T2.3 payload 回迁批次升位，AD-4；契约 = PROTOCOL.md §17.5）
    expect(protocol.MAIN_INSTANCE_ID).toBe("main");
    expect(protocol.SYSTEM_SESSION_ID).toBe("__system__");
    expect(protocol.COMMAND_TYPES.length).toBe(22); // v0.4：+1（trace.query，契约 v0.4 §1）
    expect(protocol.EVENT_TYPES.length).toBe(40); // v0.4：+3（trace.query.result / agent.instantiated / agent.model.changed）
    expect(Object.keys(protocol.EVENT_CHANNELS).length).toBe(40); // 登记目录恰等
  });
});
