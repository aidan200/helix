import { describe, expect, test } from "bun:test";
import * as protocol from "../src/index";

/**
 * TP-CL2-2 基线（A 简版）：包内导出唯一性 + 类型面完备。
 *
 * ① 运行时值导出恰为目录/登记/常量导出（v0.2：PROTOCOL_VERSION /
 *    COMMAND_TYPES / EVENT_TYPES / EVENT_CHANNELS /
 *    SYSTEM_SESSION_ID——MAIN_INSTANCE_ID 已随 T10c 退役），无意外值导出；
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
  // 命令/事件目录 v0.6 新增——agent.config 族（M6 T3 智能体配置页；经 index 可达性断言）
  protocol.AgentConfigListPayload,
  protocol.AgentConfigListCommand,
  protocol.AgentConfigSetEnabledPayload,
  protocol.AgentConfigSetEnabledCommand,
  protocol.AgentConfigProfileBlock,
  protocol.AgentConfigListResultPayload,
  protocol.AgentConfigListResultEvent,
  protocol.AgentConfigChangedPayload,
  protocol.AgentConfigChangedEvent,
  protocol.AgentConfigSetEnabledResultPayload,
  protocol.AgentConfigSetEnabledResultEvent,
  // 命令/事件目录 v0.7 新增——web 族（T4 联网状态图标；经 index 可达性断言）
  protocol.WebStatusCommand,
  protocol.WebStopCommand,
  protocol.WebConnectionState,
  protocol.WebBrowserDto,
  protocol.WebTabDto,
  protocol.WebStatusPayload,
  protocol.WebStatusResultEvent,
  protocol.WebStopResultPayload,
  protocol.WebStopResultEvent,
  protocol.WebStatusChangedEvent,
  // 命令/事件目录 v0.9 新增——web.start 显式启动通路（T7；经 index 可达性断言）
  protocol.WebStartCommand,
  protocol.WebStartResultPayload,
  protocol.WebStartResultEvent,
  // 命令/事件目录 v0.11 新增——thinking 批（iter-20260823-6ps5 T1.1；AD-2/AD-4）
  protocol.ThinkingSetPayload,
  protocol.ThinkingSetCommand,
  protocol.ThinkingChangedPayload,
  protocol.ThinkingChangedEvent,
  // 模式注册表（P1 会话模式框架 T2，mode-framework-p1；§18 微批登记）
  protocol.ModeSpec,
  protocol.StageSpec,
  protocol.ModeId,
  // 语音输入批（V1 云转写；stt 域命令 + 结果帧）
  protocol.SttTranscribePayload,
  protocol.SttTranscribeCommand,
  protocol.SttTranscribeResultPayload,
  protocol.SttTranscribeResultEvent,
  // 语音播报批（V2 TTS；voice 域三命令 + 广播帧/结果帧）
  protocol.VoiceSynthesizePayload,
  protocol.VoiceSynthesizeCommand,
  protocol.VoiceSubscribePayload,
  protocol.VoiceSubscribeCommand,
  protocol.VoiceUnsubscribeCommand,
  protocol.VoiceBroadcastKind,
  protocol.VoiceBroadcastPayload,
  protocol.VoiceBroadcastEvent,
  protocol.VoiceSynthesizeResultPayload,
  protocol.VoiceSynthesizeResultEvent,
  // 流式 TTS 批（V3b-2；voice 域流式两命令 + 三帧）
  protocol.VoiceSynthesizeStreamPayload,
  protocol.VoiceSynthesizeStreamCommand,
  protocol.VoiceSynthesizeStopCommand,
  protocol.VoiceSynthesizeChunkPayload,
  protocol.VoiceSynthesizeChunkEvent,
  protocol.VoiceSynthesizeDonePayload,
  protocol.VoiceSynthesizeDoneEvent,
  protocol.VoiceSynthesizeErrorPayload,
  protocol.VoiceSynthesizeErrorEvent,
  // 错误模型（契约 §7；v0.2 +command.unimplemented）
  protocol.ErrorCode,
];

describe("TP-CL2-② 导出面（index.ts 汇总）", () => {
  test("① 运行时值导出恰为目录/登记/常量 + 投影纯函数面（类型+行为契约，CL-4/T3.1）", () => {
    // T3.1（M4 投资批，CL-4）：协议包从类型契约升级为类型+行为契约——
    // projection/ 三域纯函数（usage/instance/trace）进入运行时导出面。
    // 注：列表按 sort() 字典序（大写先于小写）；注释按域分组标注来源。
    expect(Object.keys(protocol).sort()).toEqual([
      // 目录/登记/常量（v0.2 常量收口）+ 投影·trace 域常量（迁自 daemon TraceQuery）
      // （MAIN_INSTANCE_ID 已随 T10c 常量退役删除——legacy 判别归读侧 helper）
      "COMMAND_TYPES",
      "DEFAULT_MODE_ID", // P1 会话模式批 T2（缺省 mode 单点；§18 微批）
      "DEPRECATED_EVENT_TYPES", // 表面协议地基批（M0）：已退役事件登记面（D8 收编兼容期）
      "EVENT_CHANNELS",
      "EVENT_TYPES",
      "MODES", // P1 会话模式批 T2（模式注册表常量；§18 微批）
      "PROTOCOL_VERSION",
      "STEWARD_ASK_ERROR_KINDS", // 事故热修批⑦：steward ask 错误分类封闭词汇表（aborted 与模型失败分记）
      "SURFACE_EVENT_KINDS", // 表面协议地基批（M0）：SurfaceEvent kind 封闭词汇表（D2）
      "SURFACE_EVENT_ORIGINS", // 表面协议地基批（M0）：origin 三值（D7-2 回声过滤基础）
      "SURFACE_INSTRUCTION_FRAME_TYPES", // 表面协议地基批（M0）：指令帧注册面恒一种（D8）
      "SURFACE_NAMESPACE_KINDS", // 表面协议地基批（M0）：surfaceId 命名空间词汇表
      "SURFACE_RISK_LEVELS", // 表面协议地基批（M0）：risk 三档（D3 挂动作）
      "SURFACE_VERBS", // M2 动词注册校验面：动词封闭词汇表（D4）
      "SURFACE_VERB_CAPABILITIES", // M2 动词注册校验面：命名空间→动词封闭注册（D4）
      "SURFACE_VERB_RISKS", // M2 动词注册校验面：动词→risk 注册档（D3 挂动作）
      "SYSTEM_SESSION_ID",
      "TAIL_WINDOW_SIZE", // W3 #2.36：快照尾窗口径单源（daemon 组装 + shell 恢复骨架文案共引）
      "TRACE_PAGE_DEFAULT",
      "TRACE_PAGE_MAX",
      // 投影·trace 域（迁自 daemon TraceQuery normalize 段 + fake 过滤分页段）
      "TraceQueryInvalidError",
      // 投影·usage 域（迁自 daemon UsageLedger + shell addUsage 副本）
      "ZERO_USAGE",
      "addUsage",
      "aggregateSession",
      "applyCompaction",
      "applyUsage",
      // 投影·instance 域（迁自 daemon SpawnAnchor + EntryDtoMapper ↔ shell entryTimelineKey 同构收敛）
      "computeAnchorEntryId",
      "emptyUsageLedger", /* usage 域 */
      "entrySortKey",
      // 投影·trace 域（续）
      "hasMoreBefore",
      // 投影·usage 域（续）+ instance 域判定
      "instanceUsageOf",
      "isMainInstance",
      // 表面协议地基批（M0）：surface 域类型守卫
      "isSurfaceDescriptor",
      "isSurfaceEventKind",
      "isSurfaceEventOrigin",
      "isSurfaceNamespaceKind",
      "isSurfaceRisk",
      "isSurfaceVerb", // M2 动词注册校验面：私造动词拒收守卫
      "isSurfaceVerbAllowed", // M2 动词注册校验面：跨表面越权注册拒收守卫
      "lastMainAnchorId",
      // 投影·trace 域（续）
      "normalizeTraceQuery",
      "pageTraceEvents",
      // 表面协议地基批（M0）续
      "surfaceIdOf",
      "surfaceVerbRisk", // M2 动词注册校验面：动词 risk 注册档读取
      "validateSurfaceActArgs", // 事故热修批①：动词×命名空间参数形状校验（即时工具错误单源）
    ]);
  });

  test("② 常量语义值 + 目录计数（+ 确认链路修复批：命令 120 / 事件 149；v0.14）", () => {
    expect(protocol.PROTOCOL_VERSION).toBe("0.14"); // v0.14 批次版本位（管家工作记忆批；契约 = changelog/v0.14.md §17.17）
    expect(protocol.SYSTEM_SESSION_ID).toBe("__system__");
    expect(protocol.COMMAND_TYPES.length).toBe(120); // 表面协议地基批 +4（surface.register/unregister/event/action.result）// P5 草稿驳回批 +1（kg.node.discard）// P2 审计批 +1（kg.auto.audit） // 遗忘机制批 +2（steward.memory_pin/restore）// B1 两段式确认批 +1（steward.cancel）// B2 barge-in 批 +1（steward.interrupt）// 动态主题批 +2（config.get/set_topic）// 管家记忆 B2 批 +8（steward.memory_* 四命令 + embedding.* 四命令）// 流式 TTS 批 +2（voice.synthesize.stream/stop）// 管家公民权批 +1（agent.steward_profile.get）// 管家工作记忆批 +1（steward.history）// 流式转写批 +4（stt.stream 四命令）// 文本管家批 +6（steward 六命令）
    expect(protocol.EVENT_TYPES.length).toBe(149); // 确认链路修复批 +1（steward.pending.snapshot——订阅对账/清场帧，E-206 预留帧位落地）// 管家感知批 M0.5 +1（steward.notify——主动通知帧）// 表面协议地基批 +2（surface.action 指令帧 + surface.registered 回执）// P5 草稿驳回批 +1（kg.node.discard.result）// P2 审计批 +1（kg.auto.audit.result） // kg-triage 批 +1（kg.triage.create.result） // B1 两段式确认批 +1（steward.action.completed）// 动态主题批 +2（config.get/set_topic.result）// 管家记忆 B5 批 +1（steward.memory_written，B4a 提案帧改名——静默化）// 管家记忆 B2 批 +3（steward.memory_list.result + embedding 两帧）// 流式 TTS 批 +3（voice.synthesize.chunk/done/error）// helix-loop L1 批 +1（loop.context.compacted）// 管家公民权批 +1（agent.steward_profile.get.result）// helix-loop L0 批 +15（loop 族）// 管家驾驶舱批 +1（steward.navigate）// 管家工作记忆批 +3（history.result/tool/thinking）// 流式转写批 +3（stt.stream 三事件）// 文本管家批 +4（steward 四事件）+ 流式体验批 +1（steward.ask.delta）
    expect(Object.keys(protocol.EVENT_CHANNELS).length).toBe(149); // 确认链路修复批 +1 // 管家感知批 M0.5 +1 // 表面协议地基批 +2（surface 族两帧登记 channel "surface"）// P5 草稿驳回批 +1 // P2 审计批 +1 // 登记目录恰等（+B1 两段式确认批 1）（+ 管家记忆 B2 批 3 / helix-loop L1 批 1 / 管家公民权批 1 / helix-loop L0 批 loop 族 15）
  });
});
