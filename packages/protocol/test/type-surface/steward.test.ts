/**
 * 文本管家批（V2.5）additive 断言：
 * - steward.ask / steward.confirm / steward.subscribe / steward.unsubscribe /
 *   steward.get_config / steward.set_config 六命令（对话 + 确认闸 + feed
 *   订阅 + 设置面）；
 * - steward.ask.result 三判别（answer 直答 / confirm_required 确认闸请求——
 *   携 actionId + agentId + message 全文 / error 业务失败）；
 * - steward.ask.delta 流式增量帧（V2.5 体验批：delta 增量 + seq 单调——
 *   前端聚合，终态 ask.result 权威覆盖；工具段静默）；
 * - steward.confirm.result 两判别（ok 含注入通道回执 detail / error）；
 * - steward.feed 文本行广播帧（kind/agentId/text/seq）；
 * - steward.config.result 设置回执（enabled + model）；
 * - CHANNEL 目录扩 "steward"（新增族 = additive，不动分发器）。
 */
import { describe, expect, test } from "bun:test";
import { COMMAND_TYPES, EVENT_CHANNELS, EVENT_TYPES, PROTOCOL_VERSION } from "../../src/index";
import type {
  StewardAskCommand,
  StewardAskDeltaEvent,
  StewardAskDeltaPayload,
  StewardAskResultEvent,
  StewardAskResultPayload,
  StewardConfirmCommand,
  StewardConfirmResultEvent,
  StewardConfigResultEvent,
  StewardFeedEvent,
  StewardFeedPayload,
  StewardGetConfigCommand,
  StewardSetConfigCommand,
  StewardSubscribeCommand,
  StewardUnsubscribeCommand,
  StewardHistoryCommand,
  StewardHistoryRecord,
  StewardHistoryResultEvent,
  StewardNavigateEvent,
  StewardNavigatePayload,
  StewardToolEvent,
  StewardToolPayload,
  StewardThinkingEvent,
  StewardThinkingPayload,
  StewardMemoryListCommand,
  StewardMemoryAppendCommand,
  StewardMemoryUpdateCommand,
  StewardMemoryDeleteCommand,
  StewardMemoryListResultEvent,
  StewardMemoryWrittenEvent,
  StewardNotifyEvent,
} from "../../src/index";
import type { Equal, Expect, TypeOfChannel } from "./samples/helpers";
import { dispatchCommand, familyOf, summarizeEvent } from "./samples/helpers";

// ── 类型级断言（编译期；任一不满足 → tsc --noEmit 失败）──

// ask/confirm 载荷必填字段（additive 纪律）
type _AskText = Expect<Equal<StewardAskCommand["payload"]["text"], string>>;
type _ConfirmActionId = Expect<Equal<StewardConfirmCommand["payload"]["actionId"], string>>;

// set_config 两槽位可选
type _SetEnabled = Expect<Equal<StewardSetConfigCommand["payload"]["enabled"], boolean | undefined>>;
type _SetModel = Expect<Equal<StewardSetConfigCommand["payload"]["model"], string | undefined>>;

// ask.result 三判别
type _AnswerBranch = Expect<Equal<Extract<StewardAskResultPayload, { status: "answer" }>["text"], string>>;
type _ConfirmBranch = Expect<
  Equal<Extract<StewardAskResultPayload, { status: "confirm_required" }>["actionId"], string>
>;
type _ConfirmBranchAgent = Expect<
  Equal<Extract<StewardAskResultPayload, { status: "confirm_required" }>["agentId"], string>
>;
type _ConfirmBranchMessage = Expect<
  Equal<Extract<StewardAskResultPayload, { status: "confirm_required" }>["message"], string>
>;
type _AskErrorBranch = Expect<Equal<Extract<StewardAskResultPayload, { status: "error" }>["reason"], string>>;

// ask.delta 流式增量帧（V2.5 体验批 additive：delta 增量 + seq 单调）
type _DeltaText = Expect<Equal<StewardAskDeltaPayload["delta"], string>>;
type _DeltaSeq = Expect<Equal<StewardAskDeltaPayload["seq"], number>>;

// feed payload 必填字段
type _FeedKind = Expect<
  Equal<
    StewardFeedPayload["kind"],
    "agent.spawned" | "agent.completed" | "agent.failed" | "agent.killed" | "agent.parked" | "agent.resumed"
  >
>;
type _FeedSeq = Expect<Equal<StewardFeedPayload["seq"], number>>;

// channel = "steward" 新族窄化（familyOf case 存在 + TypeOfChannel 收窄；
// 管家驾驶舱批 +steward.navigate——投递/建会话成功后的页面切换指令帧；
// 管家记忆 B2 批 +steward.memory_list.result——条目清单回执；
// 管家感知批 M0.5 +steward.notify——分诊呈现轨主动通知帧）
type _StewardFamily = Expect<
  Equal<
    TypeOfChannel<"steward">,
    | "steward.ask.result"
      | "steward.ask.delta"
      | "steward.confirm.result"
      | "steward.action.completed"
      | "steward.feed"
      | "steward.config.result"
      | "steward.history.result"
      | "steward.tool"
      | "steward.thinking"
      | "steward.navigate"
      | "steward.notify"
      | "steward.proactive"
      | "steward.pending.snapshot"
      | "steward.memory_written"
      | "steward.memory_list.result"
      // barge-in 意图窗批 +steward.judge_stop_intent.result（语义停止判定回执）
      | "steward.judge_stop_intent.result"
      // 管家活动账批 M3-d1 +steward.activity.result（查询/清理回执）+
      // steward.activity（实时活动条目广播）
      | "steward.activity.result"
      | "steward.activity"
  >
>;

// 管家驾驶舱批：navigate 载荷必填字段（sessionId = shell 切页目标）
type _NavigateSessionId = Expect<Equal<StewardNavigatePayload["sessionId"], string>>;

// A1 工作记忆批：history 载荷 clear 可选；records 全形态判别字段
 type _HistoryClear = Expect<Equal<StewardHistoryCommand["payload"]["clear"], boolean | undefined>>;
type _RecordUser = Expect<Equal<Extract<StewardHistoryRecord, { kind: "user" }>["text"], string>>;
type _RecordAssistantThinking = Expect<
  Equal<Extract<StewardHistoryRecord, { kind: "assistant" }>["thinking"], { text: string; signature?: string } | undefined>
>;
type _RecordAssistantToolCall = Expect<
  Equal<
    Extract<StewardHistoryRecord, { kind: "assistant" }>["toolCall"],
    { id: string; name: string; args: Record<string, unknown> } | undefined
  >
>;
type _RecordToolResult = Expect<Equal<Extract<StewardHistoryRecord, { kind: "toolResult" }>["toolCallId"], string>>;
type _RecordAt = Expect<Equal<Extract<StewardHistoryRecord, { kind: "user" }>["at"], number>>;

// A1 过程帧：tool 两相 / thinking 段级
type _ToolStart = Expect<Equal<Extract<StewardToolPayload, { phase: "start" }>["argsSummary"], string>>;
type _ToolEnd = Expect<Equal<Extract<StewardToolPayload, { phase: "end" }>["resultSummary"], string>>;
type _ThinkingText = Expect<Equal<StewardThinkingPayload["text"], string>>;
type _ThinkingSeq = Expect<Equal<StewardThinkingPayload["seq"], number>>;

const askCommand: StewardAskCommand = {
  v: PROTOCOL_VERSION,
  type: "steward.ask",
  payload: { text: "现在有哪些 agent 在跑？" },
};

const confirmCommand: StewardConfirmCommand = {
  v: PROTOCOL_VERSION,
  type: "steward.confirm",
  payload: { actionId: "steward-action-1" },
};

const subscribeCommand: StewardSubscribeCommand = {
  v: PROTOCOL_VERSION,
  type: "steward.subscribe",
  payload: {},
};

const unsubscribeCommand: StewardUnsubscribeCommand = {
  v: PROTOCOL_VERSION,
  type: "steward.unsubscribe",
  payload: {},
};

const getConfigCommand: StewardGetConfigCommand = {
  v: PROTOCOL_VERSION,
  type: "steward.get_config",
  payload: {},
};

const setConfigCommand: StewardSetConfigCommand = {
  v: PROTOCOL_VERSION,
  type: "steward.set_config",
  payload: { enabled: true, model: "deepseek/deepseek-v4-flash" },
};

const askAnswer: StewardAskResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "steward",
  type: "steward.ask.result",
  payload: { status: "answer", text: "当前有 2 个实例运行中：agent-1、agent-2。" },
};

const askConfirm: StewardAskResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "steward",
  type: "steward.ask.result",
  payload: {
    status: "confirm_required",
    actionId: "steward-action-1",
    agentId: "agent-2",
    message: "顺带跑一下 lint",
  },
};

const askError: StewardAskResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "steward",
  type: "steward.ask.result",
  payload: { status: "error", reason: "管家未开启（设置页 → 文本管家 → 开启开关）" },
};

const askDelta: StewardAskDeltaEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "steward",
  type: "steward.ask.delta",
  payload: { delta: "当前有 ", seq: 1 },
};

const confirmOk: StewardConfirmResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "steward",
  type: "steward.confirm.result",
  payload: { status: "ok", agentId: "agent-2", detail: "已投递（turn 边界注入生效）" },
};

const feedFrame: StewardFeedEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "steward",
  type: "steward.feed",
  payload: { kind: "agent.completed", agentId: "agent-2", text: "agent-2 已完成：修复登录超时", seq: 1 },
};

const configResult: StewardConfigResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "steward",
  type: "steward.config.result",
  payload: {
    enabled: false,
    model: "deepseek/deepseek-v4-flash",
    summary: { enabled: false, everyTurns: 3, model: null, task: { enabled: false, model: null } },
    memory: { enabled: false, available: false, endpoint: null, judgeEndpoint: null, entryCount: 0, dim: null },
  },
};

const historyCommand: StewardHistoryCommand = {
  v: PROTOCOL_VERSION,
  type: "steward.history",
  payload: {},
};

const historyClearCommand: StewardHistoryCommand = {
  v: PROTOCOL_VERSION,
  type: "steward.history",
  payload: { clear: true },
};

const historyResult: StewardHistoryResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "steward",
  type: "steward.history.result",
  payload: {
    records: [
      { kind: "user", text: "现在有什么在跑？", at: 1760000000000 },
      {
        kind: "assistant",
        thinking: { text: "用户问全局状态，先查实例清单", signature: "sig-opaque" },
        toolCall: { id: "call-0", name: "list_instances", args: {} },
        at: 1760000000123,
      },
      { kind: "toolResult", toolCallId: "call-0", name: "list_instances", text: "[]", at: 1760000000456 },
      { kind: "assistant", text: "当前无运行中实例。", at: 1760000000789 },
    ],
  },
};

const toolStart: StewardToolEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "steward",
  type: "steward.tool",
  payload: { phase: "start", name: "list_tasks", argsSummary: "{}", seq: 1 },
};

const toolEnd: StewardToolEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "steward",
  type: "steward.tool",
  payload: { phase: "end", name: "list_tasks", resultSummary: "2 个任务（1 运行中）", seq: 2 },
};

const thinkingFrame: StewardThinkingEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "steward",
  type: "steward.thinking",
  payload: { text: "用户问任务状态，需要先取任务清单再决定是否查实例。", seq: 1 },
};

// 管家驾驶舱批：页面切换指令帧（daemon 广播——仅已订阅 steward 的连接收）
const navigateFrame: StewardNavigateEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "steward",
  type: "steward.navigate",
  payload: { sessionId: "sess-abc123" },
};

describe("文本管家批（V2.5）：steward 族 additive", () => {
  test("命令/事件/通道目录登记（COMMAND_TYPES / EVENT_TYPES / EVENT_CHANNELS）", () => {
    for (const t of [
      "steward.ask",
      "steward.confirm",
      "steward.subscribe",
      "steward.unsubscribe",
      "steward.get_config",
      "steward.set_config",
    ] as const) {
      expect(COMMAND_TYPES).toContain(t);
    }
    for (const t of [
      "steward.ask.result",
      "steward.ask.delta",
      "steward.confirm.result",
      "steward.feed",
      "steward.config.result",
    ] as const) {
      expect(EVENT_TYPES).toContain(t);
      expect(EVENT_CHANNELS[t as "steward.feed"]).toBe("steward");
    }
  });

  test("ask/confirm 命令可构造且 dispatch 窄化消费独有字段", () => {
    expect(dispatchCommand(askCommand)).toContain("steward-ask:现在有哪些 agent 在跑？");
    expect(dispatchCommand(confirmCommand)).toBe("steward-confirm:steward-action-1");
  });

  test("订阅/退订/设置命令最小载荷构造", () => {
    expect(dispatchCommand(subscribeCommand)).toBe("steward-subscribe");
    expect(dispatchCommand(unsubscribeCommand)).toBe("steward-unsubscribe");
    expect(dispatchCommand(getConfigCommand)).toBe("steward-get_config");
    expect(dispatchCommand(setConfigCommand)).toBe("steward-set_config:true:deepseek/deepseek-v4-flash");
  });

  test("ask.result 三判别窄化：answer/confirm_required/error 独有字段可达", () => {
    expect(summarizeEvent(askAnswer)).toContain("steward-answer:");
    expect(summarizeEvent(askConfirm)).toBe("steward-confirm-required:steward-action-1:agent-2:顺带跑一下 lint");
    expect(summarizeEvent(askError)).toContain("steward-error:");
  });

  test("confirm.result / feed / config.result 全字段窄化可达", () => {
    expect(summarizeEvent(confirmOk)).toBe("steward-confirm-result:ok:agent-2:已投递（turn 边界注入生效）");
    expect(feedFrame.payload.seq).toBe(1);
    expect(feedFrame.payload.kind).toBe("agent.completed");
    expect(configResult.payload.enabled).toBe(false);
  });

  test("ask.delta 流式增量帧窄化：delta/seq 字段可达 + 目录登记（V2.5 体验批）", () => {
    expect(summarizeEvent(askDelta)).toBe("steward-ask-delta:当前有 :1");
    expect(askDelta.payload.seq).toBe(1);
    expect(askDelta.payload.delta).toBe("当前有 ");
  });

  test("familyOf 分族窄化：channel=steward → 'steward/<type>'", () => {
    expect(familyOf(askAnswer)).toBe("steward/steward.ask.result");
    expect(familyOf(feedFrame)).toBe("steward/steward.feed");
    expect(familyOf(askDelta)).toBe("steward/steward.ask.delta");
  });
});

describe("管家工作记忆批（A1）：steward.history + 过程帧 additive", () => {
  test("目录登记：命令 +1 / 事件 +3 / 通道挂 steward 族", () => {
    expect(COMMAND_TYPES).toContain("steward.history");
    for (const t of ["steward.history.result", "steward.tool", "steward.thinking"] as const) {
      expect(EVENT_TYPES).toContain(t);
      expect(EVENT_CHANNELS[t as "steward.feed"]).toBe("steward");
    }
  });

  test("history 命令读/清双形态可构造且 dispatch 窄化", () => {
    expect(dispatchCommand(historyCommand)).toBe("steward-history:false");
    expect(dispatchCommand(historyClearCommand)).toBe("steward-history:true");
  });

  test("history.result 回放回执：records 全形态窄化（user/assistant 含 thinking+toolCall/toolResult）", () => {
    expect(summarizeEvent(historyResult)).toBe("steward-history-result:4:user");
    const [user, assistantTool, toolResult, assistantText] = historyResult.payload.records;
    expect(user?.kind).toBe("user");
    if (assistantTool?.kind === "assistant") {
      expect(assistantTool.thinking?.signature).toBe("sig-opaque");
      expect(assistantTool.toolCall?.name).toBe("list_instances");
      expect(assistantTool.toolCall?.id).toBe("call-0");
    } else {
      throw new Error("assistant 工具轮记录窄化失败");
    }
    expect(toolResult?.kind).toBe("toolResult");
    if (toolResult?.kind === "toolResult") expect(toolResult.toolCallId).toBe("call-0");
    expect(assistantText?.kind).toBe("assistant");
    if (assistantText?.kind === "assistant") expect(assistantText.text).toBe("当前无运行中实例。");
  });

  test("tool 两相帧 + thinking 段级帧窄化", () => {
    expect(summarizeEvent(toolStart)).toBe("steward-tool-start:list_tasks:{}:1");
    expect(summarizeEvent(toolEnd)).toBe("steward-tool-end:list_tasks:2 个任务（1 运行中）:2");
    expect(summarizeEvent(thinkingFrame)).toBe("steward-thinking:用户问任务状态，需要先取任务清单再决定是否查实例。:1");
    expect(familyOf(toolStart)).toBe("steward/steward.tool");
    expect(familyOf(thinkingFrame)).toBe("steward/steward.thinking");
    expect(familyOf(historyResult)).toBe("steward/steward.history.result");
  });
});

describe("管家驾驶舱批：steward.navigate 页面切换帧 additive", () => {
  test("目录登记（EVENT_TYPES / EVENT_CHANNELS 挂 steward 族）", () => {
    expect(EVENT_TYPES).toContain("steward.navigate");
    expect(EVENT_CHANNELS["steward.navigate"]).toBe("steward");
  });

  test("payload 窄化：sessionId 字段可达 + summarizeEvent/familyOf 分发", () => {
    expect(navigateFrame.payload.sessionId).toBe("sess-abc123");
    expect(summarizeEvent(navigateFrame)).toBe("steward-navigate:sess-abc123");
    expect(familyOf(navigateFrame)).toBe("steward/steward.navigate");
  });
});

// ── 管家记忆 B2：memory 组瘦身 + 条目管理四命令 ──────────────────────

const memorySetCommand: StewardSetConfigCommand = {
  v: PROTOCOL_VERSION,
  type: "steward.set_config",
  payload: { memory: { enabled: true, endpointId: "ep-1" } },
};

const memoryConfigResult: StewardConfigResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "steward",
  type: "steward.config.result",
  payload: {
    enabled: true,
    model: "deepseek/deepseek-v4-flash",
    summary: { enabled: true, everyTurns: 3, model: "deepseek/deepseek-v4-flash", task: { enabled: true, model: "deepseek/deepseek-v4-flash" } },
    memory: {
      enabled: true,
      available: true,
      endpoint: { id: "ep-1", name: "Ollama 本地", model: "bge-m3", hasApiKey: false },
      judgeEndpoint: { id: "ep-9", name: "Jev", model: "jev-latest", hasApiKey: true },
      entryCount: 3,
      dim: 1024,
      recallTopK: 8,
      recallPool: 32,
      recallMinScore: 0.3,
    },
  },
};

const memoryListCommand: StewardMemoryListCommand = {
  v: PROTOCOL_VERSION,
  type: "steward.memory_list",
  payload: {},
};

const memoryAppendCommand: StewardMemoryAppendCommand = {
  v: PROTOCOL_VERSION,
  type: "steward.memory_append",
  payload: { text: "用户偏好简洁回复", kind: "preference" },
};

const memoryUpdateCommand: StewardMemoryUpdateCommand = {
  v: PROTOCOL_VERSION,
  type: "steward.memory_update",
  payload: { id: 2, text: "主技术栈：TypeScript + React（更新）" },
};

const memoryDeleteCommand: StewardMemoryDeleteCommand = {
  v: PROTOCOL_VERSION,
  type: "steward.memory_delete",
  payload: { id: 2 },
};

const memoryListResult: StewardMemoryListResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "steward",
  type: "steward.memory_list.result",
  payload: {
    entries: [
      { id: 1, text: "用户偏好简洁回复", kind: "preference", createdAt: 1760000000000, sourceTurn: "manual" },
      { id: 2, text: "主技术栈：TypeScript + React", kind: "fact", createdAt: 1760000100000, sourceTurn: "steward-turn" },
    ],
  },
};

describe("管家记忆 B2：memory 组瘦身（endpointId 引用态）", () => {
  test("set_config.memory 两槽位可选（enabled/endpointId——baseUrl/apiKey/model 退役）", () => {
    expect(dispatchCommand(memorySetCommand)).toBe("steward-set_config:undefined:-");
    expect(memorySetCommand.payload.memory?.endpointId).toBe("ep-1");
  });

  test("config.result.memory.endpoint 引用态窄化（id/name/model/hasApiKey——无 baseUrl）", () => {
    const endpoint = memoryConfigResult.payload.memory.endpoint;
    if (endpoint === null) throw new Error("endpoint 引用态窄化失败");
    expect(endpoint.id).toBe("ep-1");
    expect(endpoint.model).toBe("bge-m3");
    expect(endpoint.hasApiKey).toBe(false);
    expect("baseUrl" in endpoint).toBe(false);
    expect(memoryConfigResult.payload.memory.available).toBe(true);
  });
});

// ── 召回资格阈值进配置（memory.recallMinScore，additive）─────────

describe("memory.recallMinScore additive（召回资格闸阈值进配置域）", () => {
  test("set_config.memory 补丁接受 recallTopK/recallPool/recallMinScore（additive 可选 number）", () => {
    const cmd: StewardSetConfigCommand = {
      v: PROTOCOL_VERSION,
      type: "steward.set_config",
      payload: { memory: { recallTopK: 8, recallPool: 32, recallMinScore: 0.5 } },
    };
    expect(dispatchCommand(cmd)).toBe("steward-set_config:undefined:-");
    expect(cmd.payload.memory?.recallMinScore).toBe(0.5);
  });

  test("config.result.memory 回执携带 recallMinScore 生效值（additive 可选——旧壳/未装配缺席忽略）", () => {
    expect(memoryConfigResult.payload.memory.recallTopK).toBe(8);
    expect(memoryConfigResult.payload.memory.recallPool).toBe(32);
    expect(memoryConfigResult.payload.memory.recallMinScore).toBe(0.3);
  });
});

describe("管家记忆 B2：memory_* 四命令 additive", () => {
  test("目录登记（COMMAND_TYPES / EVENT_TYPES / EVENT_CHANNELS 挂 steward 族）", () => {
    for (const t of ["steward.memory_list", "steward.memory_append", "steward.memory_update", "steward.memory_delete"] as const) {
      expect(COMMAND_TYPES).toContain(t);
    }
    expect(EVENT_TYPES).toContain("steward.memory_list.result");
    expect(EVENT_CHANNELS["steward.memory_list.result"]).toBe("steward");
  });

  test("四命令可构造且 dispatch 窄化（append kind 缺省面 + update/delete id）", () => {
    expect(dispatchCommand(memoryListCommand)).toBe("steward-memory_list");
    expect(dispatchCommand(memoryAppendCommand)).toBe("steward-memory_append:用户偏好简洁回复:preference");
    expect(dispatchCommand(memoryUpdateCommand)).toBe("steward-memory_update:2:主技术栈：TypeScript + React（更新）");
    expect(dispatchCommand(memoryDeleteCommand)).toBe("steward-memory_delete:2");
  });

  test("memory_list.result 条目行窄化（id/text/kind/createdAt/sourceTurn）", () => {
    expect(summarizeEvent(memoryListResult)).toBe("steward-memory-list:2:preference");
    const first = memoryListResult.payload.entries[0];
    expect(first?.sourceTurn).toBe("manual");
    expect(first?.createdAt).toBe(1760000000000);
    expect(familyOf(memoryListResult)).toBe("steward/steward.memory_list.result");
  });
});

// ── 管家记忆 B5：judgeEndpointId 引用 + memory_written 通知帧 ──────────

const memoryWrittenFrame: StewardMemoryWrittenEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "steward",
  type: "steward.memory_written",
  payload: { text: "用户偏好 shell 测试用 vitest", mode: "added" },
};

describe("管家记忆 B5：judgeEndpointId 引用 + memory_written 通知帧", () => {
  test("set_config.memory 三槽位可选（judgeEndpointId = classifier 端点引用）", () => {
    const cmd: StewardSetConfigCommand = {
      v: PROTOCOL_VERSION,
      type: "steward.set_config",
      payload: { memory: { judgeEndpointId: "ep-9" } },
    };
    expect(cmd.payload.memory?.judgeEndpointId).toBe("ep-9");
    expect(cmd.payload.memory?.endpointId).toBeUndefined();
  });

  test("config.result.memory.judgeEndpoint 引用态窄化（id/name/model/hasApiKey）", () => {
    const judge = memoryConfigResult.payload.memory.judgeEndpoint;
    if (judge === null) throw new Error("judgeEndpoint 引用态窄化失败");
    expect(judge.id).toBe("ep-9");
    expect(judge.model).toBe("jev-latest");
    expect("baseUrl" in judge).toBe(false);
  });

  test("memory_written 事件目录登记 + payload 窄化（与 feed 同订阅闸）", () => {
    expect(EVENT_TYPES).toContain("steward.memory_written");
    expect(EVENT_CHANNELS["steward.memory_written"]).toBe("steward");
    expect(summarizeEvent(memoryWrittenFrame)).toBe(
      "steward-memory:added:用户偏好 shell 测试用 vitest",
    );
    expect(familyOf(memoryWrittenFrame)).toBe("steward/steward.memory_written");
  });
});

// ── 管家感知批（M0.5）：steward.notify 主动通知帧（feed 族事件帧 additive）──

const notifyFrame: StewardNotifyEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "steward",
  type: "steward.notify",
  payload: {
    urgency: "normal",
    title: "任务完成",
    body: "M0.5 感知链路测试已全部通过。",
    seq: 1,
    suggestions: [{ label: "去任务页看看", verb: "open_tasks" }],
  },
};

describe("管家感知批：steward.notify 主动通知帧（与 feed 同订阅闸，事件帧非指令帧）", () => {
  test("目录登记（EVENT_TYPES / EVENT_CHANNELS 挂 steward 族）", () => {
    expect(EVENT_TYPES).toContain("steward.notify");
    expect(EVENT_CHANNELS["steward.notify"]).toBe("steward");
  });

  test("payload 窄化：urgency/title/body/suggestions（动词指针可选）/seq + 分发", () => {
    expect(notifyFrame.payload.urgency).toBe("normal");
    expect(notifyFrame.payload.title).toBe("任务完成");
    expect(notifyFrame.payload.body).not.toContain("agent-");
    expect(notifyFrame.payload.suggestions?.[0]?.label).toBe("去任务页看看");
    expect(notifyFrame.payload.suggestions?.[0]?.verb).toBe("open_tasks");
    expect(notifyFrame.payload.seq).toBe(1);
    expect(summarizeEvent(notifyFrame)).toBe("steward-notify:normal:任务完成:1");
    expect(familyOf(notifyFrame)).toBe("steward/steward.notify");
  });
});

// ── M3-a 批：steward.proactive 对话内主动汇报实时帧（CAND-601 闭环）──

import type { StewardProactiveEvent, StewardProactivePayload } from "../../src/index";

const proactiveFrame: StewardProactiveEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "steward",
  type: "steward.proactive",
  payload: {
    title: "部署完成",
    text: "部署服务这轮跑完了，健康检查全部通过。",
    suggestions: [{ label: "看看报告", verb: "open_tasks" }],
    seq: 1,
  },
};

describe("M3-a 批：steward.proactive 主动汇报实时帧（additive 事件帧——与 feed 同订阅闸）", () => {
  test("目录登记（EVENT_TYPES / EVENT_CHANNELS 挂 steward 族）", () => {
    expect(EVENT_TYPES).toContain("steward.proactive");
    expect(EVENT_CHANNELS["steward.proactive"]).toBe("steward");
  });

  test("payload 窄化：title/text/suggestions（同 notify 建议形态）/seq 单调", () => {
    expect(proactiveFrame.payload.title).toBe("部署完成");
    expect(proactiveFrame.payload.text).toContain("健康检查");
    expect(proactiveFrame.payload.suggestions?.[0]?.label).toBe("看看报告");
    expect(proactiveFrame.payload.suggestions?.[0]?.verb).toBe("open_tasks");
    expect(proactiveFrame.payload.seq).toBe(1);
    expect(summarizeEvent(proactiveFrame)).toBe("steward-proactive:部署完成:1");
    expect(familyOf(proactiveFrame)).toBe("steward/steward.proactive");
  });

  test("信封纪律：daemon 级全局帧（SYSTEM_SESSION_ID + channel steward——无会话作用域）", () => {
    expect(proactiveFrame.sessionId).toBe("__system__");
    expect(proactiveFrame.channel).toBe("steward");
    expect(proactiveFrame.type).toBe("steward.proactive");
  });

  test("payload 类型面：title/text/seq 必填 + suggestions 可选（additive 缺省容忍）", () => {
    const minimal: StewardProactivePayload = { title: "t", text: "x", seq: 2 };
    expect(minimal.seq).toBe(2);
    expect(minimal.suggestions).toBeUndefined();
  });
});
